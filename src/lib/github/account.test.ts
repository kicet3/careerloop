/** GitHub 연결(PGlite): 암호문 저장, 충돌, 토큰 갱신(동시 요청은 한 번만), 갱신 실패 → 다시 연결, 연결 해제·탈퇴 CASCADE. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { createFakeGithub, FAKE_GITHUB_ENV } from "@/test/fake-github";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let account: typeof import("./account");
let oauth: typeof import("./oauth");
let snapshots: typeof import("./snapshots");

const HOUR = 60 * 60_000;

beforeAll(async () => {
  Object.assign(process.env, FAKE_GITHUB_ENV);
  tdb = await createTestDb();
  account = await import("./account");
  oauth = await import("./oauth");
  snapshots = await import("./snapshots");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

const tokens = (n: number, now: number, accessMs = 8 * HOUR) => ({
  accessToken: `ghu_plain_${n}`,
  accessTokenExpiresAt: new Date(now + accessMs),
  refreshToken: `ghr_plain_${n}`,
  refreshTokenExpiresAt: new Date(now + 180 * 24 * HOUR),
});
const ghUser = { id: "777", login: "octo", avatarUrl: null };

describe("saveGithubConnection", () => {
  it("토큰은 암호문으로만 저장하고 상태 응답에는 토큰이 없다", async () => {
    const cfg = oauth.githubConfig()!;
    expect(await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now()), cfg)).toEqual({ ok: true });
    const row = await tdb.prisma.githubAccount.findUniqueOrThrow({ where: { userId: "ua" } });
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("ghu_plain_1");
    expect(JSON.stringify(row)).not.toContain("ghr_plain_1");
    const status = await account.getGithubStatus("ua");
    expect(status).toMatchObject({ configured: true, connected: true, status: "active", login: "octo", includePrivate: false });
    expect(status.installUrl).toBe("https://github.com/apps/careerloop-test/installations/new");
    expect(JSON.stringify(status)).not.toMatch(/ghu_|ghr_|v1\./);
    expect((await account.getGithubToken("ua")).token).toBe("ghu_plain_1");
  });

  it("같은 GitHub 계정이 다른 사용자에게 연결돼 있으면 conflict", async () => {
    const cfg = oauth.githubConfig()!;
    await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now()), cfg);
    expect(await account.saveGithubConnection("ub", ghUser, tokens(2, Date.now()), cfg)).toEqual({ ok: false, reason: "conflict" });
  });

  it("설정이 없으면 configured=false(남은 연결 기록은 보여 줘 연결 해제할 수 있게)", async () => {
    expect(await account.getGithubStatus("ua", { config: () => null })).toMatchObject({ configured: false, connected: false });
    await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now()), oauth.githubConfig()!);
    expect(await account.getGithubStatus("ua", { config: () => null })).toMatchObject({ configured: false, connected: true, login: "octo", installUrl: null });
  });

  it("다른 GitHub 계정으로 바꿔 연결하면 이전 계정의 권한을 해지해 본다", async () => {
    const cfg = oauth.githubConfig()!;
    await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now()), cfg);
    const gh = createFakeGithub();
    expect(await account.saveGithubConnection("ua", { id: "888", login: "other", avatarUrl: null }, tokens(2, Date.now()), cfg, { fetch: gh.fetch })).toEqual({ ok: true });
    const revoke = gh.calls.find((c) => c.method === "DELETE");
    expect(JSON.parse(revoke!.body!)).toEqual({ access_token: "ghu_plain_1" });
    expect((await account.getGithubStatus("ua")).login).toBe("other");
    // 같은 계정으로 다시 연결할 때는 해지하지 않는다
    const again = createFakeGithub();
    await account.saveGithubConnection("ua", { id: "888", login: "other", avatarUrl: null }, tokens(3, Date.now()), cfg, { fetch: again.fetch });
    expect(again.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("getGithubToken 갱신", () => {
  it("만료 5분 전이면 갱신하고, 동시에 불러도 갱신은 한 번만", async () => {
    const now = Date.now();
    await account.saveGithubConnection("ua", ghUser, tokens(1, now, 2 * 60_000), oauth.githubConfig()!);
    const gh = createFakeGithub();
    const [a, b] = await Promise.all([account.getGithubToken("ua", { fetch: gh.fetch }), account.getGithubToken("ua", { fetch: gh.fetch })]);
    const refreshCalls = gh.calls.filter((c) => c.url.endsWith("/login/oauth/access_token"));
    expect(refreshCalls).toHaveLength(1);
    expect(new URLSearchParams(refreshCalls[0]!.body ?? "").get("refresh_token")).toBe("ghr_plain_1");
    expect(a.token).toBe("ghu_access_1");
    expect(b.token).toBe("ghu_access_1");
    // 다시 부르면 갱신하지 않는다
    expect((await account.getGithubToken("ua", { fetch: gh.fetch })).token).toBe("ghu_access_1");
    expect(gh.calls.filter((c) => c.url.endsWith("/login/oauth/access_token"))).toHaveLength(1);
  });

  it("갱신이 거절되면 reauth_required로 바꾸고 토큰 칸을 비운다(행은 남는다)", async () => {
    await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now(), 0), oauth.githubConfig()!);
    const gh = createFakeGithub();
    gh.refreshResponse = () => Response.json({ error: "bad_refresh_token" });
    await expect(account.getGithubToken("ua", { fetch: gh.fetch })).rejects.toMatchObject({ code: "github_reauth", status: 409 });
    const row = await tdb.prisma.githubAccount.findUniqueOrThrow({ where: { userId: "ua" } });
    expect(row).toMatchObject({ status: "reauth_required", accessTokenEnc: null, refreshTokenEnc: null });
    expect((await account.getGithubStatus("ua")).status).toBe("reauth_required");
  });

  it("갱신 요청이 일시적으로 실패하면(5xx·JSON 아님·설정 오류) 연결을 그대로 두고 502", async () => {
    await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now(), 0), oauth.githubConfig()!);
    const gh = createFakeGithub();
    for (const res of [
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => Response.json({ error: "incorrect_client_credentials" }),
      () => new Response("oops", { status: 200 }),
    ]) {
      gh.refreshResponse = res;
      await expect(account.getGithubToken("ua", { fetch: gh.fetch })).rejects.toMatchObject({ code: "github_failed", status: 502 });
    }
    const row = await tdb.prisma.githubAccount.findUniqueOrThrow({ where: { userId: "ua" } });
    expect(row.status).toBe("active");
    expect(row.refreshTokenEnc).not.toBeNull();
    // 장애가 끝나면 그대로 갱신된다
    gh.refreshResponse = null;
    expect((await account.getGithubToken("ua", { fetch: gh.fetch })).token).toBe("ghu_access_1");
  });

  it("withGithubReauth: 401(github_reauth)만 reauth_required로 바꾼다", async () => {
    await account.saveGithubConnection("ua", ghUser, tokens(1, Date.now()), oauth.githubConfig()!);
    const { GithubApiError, GithubAuthError } = await import("./types");
    await expect(account.withGithubReauth("ua", async () => Promise.reject(new GithubApiError("x")))).rejects.toBeInstanceOf(GithubApiError);
    expect((await account.getGithubStatus("ua")).status).toBe("active");
    await expect(account.withGithubReauth("ua", async () => Promise.reject(new GithubAuthError()))).rejects.toBeInstanceOf(GithubAuthError);
    expect((await account.getGithubStatus("ua")).status).toBe("reauth_required");
  });

  it("연결이 없으면 github_not_connected, 설정이 없으면 503", async () => {
    await expect(account.getGithubToken("ub")).rejects.toMatchObject({ code: "github_not_connected" });
    await expect(account.getGithubToken("ua", { config: () => null })).rejects.toMatchObject({ status: 503, code: "github_unavailable" });
  });
});

describe("연결 해제·탈퇴", () => {
  async function connectWithSnapshot(userId: string) {
    await account.saveGithubConnection(userId, { ...ghUser, id: `gh-${userId}` }, tokens(1, Date.now()), oauth.githubConfig()!);
    const gh = createFakeGithub({ owner: "octo" });
    await snapshots.getOrFetchSnapshot(userId, { owner: "octo", repo: "career-app" }, {}, { fetch: gh.fetch });
    return gh;
  }

  it("연결 해제: Basic 인증으로 권한을 해지하고 행·저장소 정보를 지운다", async () => {
    const gh = await connectWithSnapshot("ua");
    expect(await tdb.prisma.githubRepoSnapshot.count()).toBe(1);
    expect(await account.disconnectGithub("ua", { fetch: gh.fetch })).toEqual({ revoked: true, deleted: true });
    const revoke = gh.calls.find((c) => c.method === "DELETE")!;
    expect(revoke.url).toBe(`https://api.github.com/applications/${FAKE_GITHUB_ENV.GITHUB_APP_CLIENT_ID}/grant`);
    expect(revoke.headers.authorization).toBe(`Basic ${Buffer.from(`${FAKE_GITHUB_ENV.GITHUB_APP_CLIENT_ID}:${FAKE_GITHUB_ENV.GITHUB_APP_CLIENT_SECRET}`).toString("base64")}`);
    expect(JSON.parse(revoke.body!)).toEqual({ access_token: "ghu_plain_1" });
    expect(await tdb.prisma.githubAccount.count()).toBe(0);
    expect(await tdb.prisma.githubRepoSnapshot.count()).toBe(0);
  });

  it("권한 해지가 실패해도 연결 정보는 지운다", async () => {
    await connectWithSnapshot("ua");
    const failing = (async () => {
      throw new Error("down");
    }) as typeof fetch;
    expect(await account.disconnectGithub("ua", { fetch: failing })).toEqual({ revoked: false, deleted: true });
    expect(await tdb.prisma.githubAccount.count()).toBe(0);
  });

  it("탈퇴: 권한 해지를 부르고(실패해도 진행) GitHub 연결·저장소 정보가 CASCADE로 지워진다, 다른 사용자 것은 남는다", async () => {
    await connectWithSnapshot("ua");
    await connectWithSnapshot("ub");
    const { deleteAccount } = await import("@/lib/auth/account");
    const revoke = vi.fn(async () => {
      throw new Error("github down");
    });
    expect(await deleteAccount("ua", { deleteGraph: async () => {}, deleteStorage: async () => {}, revokeGithub: revoke })).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledWith("ua");
    expect(await tdb.prisma.githubAccount.count({ where: { userId: "ua" } })).toBe(0);
    expect(await tdb.prisma.githubRepoSnapshot.count({ where: { userId: "ua" } })).toBe(0);
    expect(await tdb.prisma.githubRepoSnapshot.count({ where: { userId: "ub" } })).toBe(1);
  });
});

describe("저장소 정보(snapshot)", () => {
  it("24시간 안에는 다시 쓰고(GitHub을 부르지 않음), force면 ETag로 다시 확인한다", async () => {
    await account.saveGithubConnection("ua", { id: "1", login: "octo", avatarUrl: null }, tokens(1, Date.now()), oauth.githubConfig()!);
    const gh = createFakeGithub();
    const first = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: gh.fetch });
    expect(first.fetched).toBe(true);
    expect(first.snapshot.brief).toContain("저장소: octo/career-app");
    const n = gh.calls.length;
    const again = await snapshots.getOrFetchSnapshot("ua", { owner: "Octo", repo: "Career-App" }, {}, { fetch: gh.fetch });
    expect(again.fetched).toBe(false);
    expect(gh.calls.length).toBe(n);
    const forced = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, { force: true }, { fetch: gh.fetch });
    expect(forced.fetched).toBe(true);
    expect(gh.calls.length).toBe(n + 1); // 304 한 번
    expect(gh.calls.at(-1)!.headers["if-none-match"]).toBe('"etag-1"');
  });

  it("일부를 못 읽은 정보는 etag 없이 저장해 '다시 동기화'가 전부 다시 읽는다", async () => {
    await account.saveGithubConnection("ua", { id: "1", login: "octo", avatarUrl: null }, tokens(1, Date.now()), oauth.githubConfig()!);
    const gh = createFakeGithub();
    const readmeDown = (async (u: RequestInfo | URL, init?: RequestInit) =>
      String(u).endsWith("/readme") ? new Response("x", { status: 500 }) : gh.fetch(u, init)) as typeof fetch;
    const first = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: readmeDown });
    expect(first.snapshot.facts.warnings.join(" ")).toMatch(/README/);
    expect((await tdb.prisma.githubRepoSnapshot.findFirstOrThrow({ where: { userId: "ua" } })).etag).toBeNull();
    const n = gh.calls.length;
    const forced = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, { force: true }, { fetch: gh.fetch });
    expect(gh.calls[n]!.headers["if-none-match"]).toBeUndefined();
    expect(forced.snapshot.facts.readme).toContain("취업 준비를 돕는 앱");
    expect(forced.snapshot.facts.warnings).toEqual([]);
  });

  it("GitHub API가 401이면(앱 권한 해지 등) reauth_required로 바꾸고 토큰을 비운다", async () => {
    await account.saveGithubConnection("ua", { id: "1", login: "octo", avatarUrl: null }, tokens(1, Date.now()), oauth.githubConfig()!);
    const gh = createFakeGithub();
    gh.repoOverride = () => new Response(null, { status: 401 });
    await expect(snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: gh.fetch })).rejects.toMatchObject({ code: "github_reauth" });
    const row = await tdb.prisma.githubAccount.findUniqueOrThrow({ where: { userId: "ua" } });
    expect(row).toMatchObject({ status: "reauth_required", accessTokenEnc: null, refreshTokenEnc: null });
    expect((await account.getGithubStatus("ua")).status).toBe("reauth_required");
  });

  it("기여하지 않은 저장소는 403, 비공개는 허용했을 때만", async () => {
    await account.saveGithubConnection("ua", { id: "1", login: "stranger", avatarUrl: null }, tokens(1, Date.now()), oauth.githubConfig()!);
    const none = createFakeGithub({ myCommits: [], myCommitCount: 0 });
    await expect(snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: none.fetch })).rejects.toMatchObject({
      status: 403,
      code: "github_not_contributor",
    });
    const priv = createFakeGithub({ private: true });
    await expect(snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: priv.fetch })).rejects.toMatchObject({
      code: "github_private",
    });
    await account.setGithubIncludePrivate("ua", true);
    const ok = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: priv.fetch });
    expect(ok.snapshot.private).toBe(true);
    expect(ok.snapshot.brief).toContain("비공개");
    // 화면 표시: 허용을 끄면 'AI에 보내지 않음'
    expect(snapshots.threadRepoView(ok.snapshot, Date.now(), true).aiExcluded).toBe(false);
    expect(snapshots.threadRepoView(ok.snapshot, Date.now(), false).aiExcluded).toBe(true);
  });

  it("프로젝트 연결: 한 프로젝트에 저장소 하나, 지운 프로젝트는 연결을 푼다", async () => {
    await account.saveGithubConnection("ua", { id: "1", login: "octo", avatarUrl: null }, tokens(1, Date.now()), oauth.githubConfig()!);
    const a = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "career-app" }, {}, { fetch: createFakeGithub().fetch });
    const b = await snapshots.getOrFetchSnapshot("ua", { owner: "octo", repo: "other" }, {}, { fetch: createFakeGithub({ name: "other", id: 9 }).fetch });
    await snapshots.linkSnapshotToProject("ua", a.snapshot.id, "p1");
    await expect(snapshots.linkSnapshotToProject("ua", b.snapshot.id, "p1")).rejects.toMatchObject({ status: 409 });
    expect((await snapshots.snapshotForProject("ua", "p1"))?.fullName).toBe("octo/career-app");
    await snapshots.unlinkDeletedProjects("ua", ["p1", "stale"]);
    expect(await snapshots.snapshotForProject("ua", "p1")).toBeNull();
  });
});
