/**
 * 계정·동의 API(PGlite): 동의 화면 제출(POST /api/consents), 광고 수신 동의·철회(PATCH /api/account/consents),
 * 회원 탈퇴(DELETE /api/account). 모두 로그인만 확인하므로 승인 대기 사용자도 쓸 수 있다.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {} }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

let tdb: TestDb;
let consents: typeof import("../consents/route");
let marketing: typeof import("./consents/route");
let account: typeof import("./route");
let profile: typeof import("./profile/route");
let docs: typeof import("@/lib/legal/consents");

const ORIGIN = "http://localhost:3000";

async function seed(id: string, status: string, withConsent: boolean) {
  await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status } });
  const token = `tok-${id}`;
  await tdb.prisma.session.create({
    data: { id: createHash("sha256").update(token).digest("hex"), userId: id, expiresAt: new Date(Date.now() + 20 * 86_400_000) },
  });
  if (withConsent) {
    await tdb.prisma.userConsent.createMany({
      data: docs.REQUIRED_CONSENT_TYPES.map((type) => ({ userId: id, type, version: docs.CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
    });
  }
  jar.set("rp_session", token);
}

const json = (url: string, method: string, body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${url}`, { method, body: JSON.stringify(body), headers: { origin, host: "localhost:3000", "user-agent": "ua" } });

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "NEO4J_URI", "ADMIN_EMAILS"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-account-api-")), "storage");
  tdb = await createTestDb();
  docs = await import("@/lib/legal/consents");
  consents = await import("../consents/route");
  marketing = await import("./consents/route");
  account = await import("./route");
  profile = await import("./profile/route");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  await tdb.reset();
});

describe("POST /api/consents (동의 화면)", () => {
  it("로그인하지 않으면 401", async () => {
    expect((await consents.POST(json("/api/consents", "POST", { terms: true, privacy: true, age14: true }))).status).toBe(401);
  });

  it("필수 항목이 빠지면 400이고 기록하지 않는다", async () => {
    await seed("p", "pending", false);
    const res = await consents.POST(json("/api/consents", "POST", { terms: true, privacy: true }));
    expect(res.status).toBe(400);
    expect(await tdb.prisma.userConsent.count()).toBe(0);
  });

  it("승인 대기 사용자: 필수 항목을 기록하고 decision=pending", async () => {
    await seed("p", "pending", false);
    const res = await consents.POST(json("/api/consents", "POST", { terms: true, privacy: true, age14: true, marketing: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, decision: "pending" });
    const rows = await tdb.prisma.userConsent.findMany({ where: { userId: "p" } });
    // 광고 수신은 체크하지 않았으면 기록하지 않는다(이전 동의를 철회로 바꾸지 않음).
    expect(rows.map((r) => r.type).sort()).toEqual(["age14", "privacy", "terms"]);
    expect(rows.every((r) => r.source === "gate")).toBe(true);
  });

  it("승인된 사용자는 decision=ok, 광고 수신 체크도 기록", async () => {
    await seed("a", "approved", false);
    const res = await consents.POST(json("/api/consents", "POST", { terms: true, privacy: true, age14: true, marketing: true }));
    expect(await res.json()).toEqual({ ok: true, decision: "ok" });
    expect(await tdb.prisma.userConsent.count({ where: { userId: "a", type: "marketing", agreed: true } })).toBe(1);
  });

  it("정지된 사용자는 403, 다른 출처는 403", async () => {
    await seed("s", "suspended", false);
    expect((await consents.POST(json("/api/consents", "POST", { terms: true, privacy: true, age14: true }))).status).toBe(403);
    expect((await consents.POST(json("/api/consents", "POST", {}, "https://evil.example"))).status).toBe(403);
  });
});

describe("/api/account/consents (광고 수신)", () => {
  it("동의 → 철회를 append-only로 기록하고 현재 값을 돌려준다", async () => {
    await seed("a", "approved", true);
    expect((await marketing.PATCH(json("/api/account/consents", "PATCH", { marketing: true }))).status).toBe(200);
    expect(await (await marketing.GET()).json()).toMatchObject({ marketing: true });
    expect((await marketing.PATCH(json("/api/account/consents", "PATCH", { marketing: false }))).status).toBe(200);
    const body = (await (await marketing.GET()).json()) as { marketing: boolean; history: { type: string; agreed: boolean; source: string }[] };
    expect(body.marketing).toBe(false);
    expect(body.history.filter((h) => h.type === "marketing").map((h) => [h.agreed, h.source])).toEqual([
      [false, "account"],
      [true, "account"],
    ]);
  });

  it("승인 전 사용자도 철회할 수 있다, 잘못된 본문은 400", async () => {
    await seed("p", "pending", false);
    expect((await marketing.PATCH(json("/api/account/consents", "PATCH", { marketing: false }))).status).toBe(200);
    expect((await marketing.PATCH(json("/api/account/consents", "PATCH", { marketing: "no" }))).status).toBe(400);
  });
});

describe("DELETE /api/account (회원 탈퇴)", () => {
  it("확인 문구가 틀리면 400이고 아무것도 지우지 않는다", async () => {
    await seed("a", "approved", true);
    const res = await account.DELETE(json("/api/account", "DELETE", { confirm: "탈퇴" }));
    expect(res.status).toBe(400);
    expect(await tdb.prisma.user.count()).toBe(1);
  });

  it("승인 대기 사용자도 탈퇴할 수 있고, 계정·세션·동의가 지워지고 쿠키가 비워진다", async () => {
    await seed("p", "pending", true);
    await tdb.prisma.user.create({ data: { id: "other", email: "other@x.com", status: "approved" } });
    const { ACCOUNT_DELETE_CONFIRM } = await import("@/lib/domain/users");
    const res = await account.DELETE(json("/api/account", "DELETE", { confirm: ACCOUNT_DELETE_CONFIRM }));
    expect(res.status).toBe(200);
    expect(await tdb.prisma.user.findMany({ select: { id: true } })).toEqual([{ id: "other" }]);
    expect(await tdb.prisma.session.count()).toBe(0);
    expect(await tdb.prisma.userConsent.count()).toBe(0);
    expect(jar.has("rp_session")).toBe(false);
  });

  it("로그인하지 않으면 401, 다른 출처는 403", async () => {
    expect((await account.DELETE(json("/api/account", "DELETE", { confirm: "탈퇴합니다" }))).status).toBe(401);
    expect((await account.DELETE(json("/api/account", "DELETE", { confirm: "탈퇴합니다" }, "https://evil.example"))).status).toBe(403);
  });
});

describe("PATCH /api/account/profile (이름 바꾸기)", () => {
  it("로그인 401, 다른 출처 403, 빈 이름·41자 400", async () => {
    expect((await profile.PATCH(json("/api/account/profile", "PATCH", { name: "새 이름" }))).status).toBe(401);
    await seed("n", "pending", false);
    expect((await profile.PATCH(json("/api/account/profile", "PATCH", { name: "새 이름" }, "https://evil.example"))).status).toBe(403);
    expect((await profile.PATCH(json("/api/account/profile", "PATCH", { name: "   " }))).status).toBe(400);
    expect((await profile.PATCH(json("/api/account/profile", "PATCH", { name: "가".repeat(41) }))).status).toBe(400);
    expect((await tdb.prisma.user.findUnique({ where: { id: "n" } }))?.name).toBeNull();
  });

  it("공백·제어 문자를 정리해 저장한다(승인 대기 사용자도 가능)", async () => {
    await seed("n", "pending", false);
    const res = await profile.PATCH(json("/api/account/profile", "PATCH", { name: "  홍   길동\u0007 " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "홍 길동" });
    expect((await tdb.prisma.user.findUnique({ where: { id: "n" } }))?.name).toBe("홍 길동");
  });
});
