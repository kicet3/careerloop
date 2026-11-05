import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let upsertGoogleUser: typeof import("./google-user").upsertGoogleUser;
let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  ({ upsertGoogleUser } = await import("./google-user"));
});
afterAll(() => tdb.close());

async function user(id: string) {
  return tdb.prisma.user.findUnique({ where: { id } });
}

describe("upsertGoogleUser", () => {
  it("이름의 NUL 문자는 지우고 저장한다(Postgres text는 NUL을 받지 않는다)", async () => {
    const r = await upsertGoogleUser({ sub: "g-nul", email: "nul@gmail.com", name: "a\u0000b" });
    if (!r.ok) throw new Error();
    expect((await user(r.userId))!.name).toBe("ab");
  });

  it("처음이면 비밀번호 없는 사용자를 만들고, 다시 오면 같은 사용자", async () => {
    const r = await upsertGoogleUser({ sub: "g-1", email: "new@gmail.com", name: "새 사용자" });
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) throw new Error();
    const u = await user(r.userId);
    expect(u).toMatchObject({ email: "new@gmail.com", name: "새 사용자", passwordHash: null, googleSub: "g-1" });

    // 이메일이 바뀌어도 sub로 찾는다.
    expect(await upsertGoogleUser({ sub: "g-1", email: "changed@gmail.com", name: null })).toEqual({
      ok: true,
      userId: r.userId,
      created: false,
      linked: false,
    });
  });

  it("같은 이메일(대소문자 무시)의 비밀번호 계정에 연결하고, 기존 비밀번호·세션은 없앤다", async () => {
    await tdb.prisma.user.create({ data: { id: "pw1", email: "old@example.com", passwordHash: "h" } });
    await tdb.prisma.session.create({ data: { id: "s-pw1", userId: "pw1", expiresAt: new Date(Date.now() + 60_000) } });
    const r = await upsertGoogleUser({ sub: "g-2", email: "Old@Example.com", name: "x", hd: "example.com" });
    expect(r).toEqual({ ok: true, userId: "pw1", created: false, linked: true });
    expect(await user("pw1")).toMatchObject({ googleSub: "g-2", passwordHash: null });
    expect(await tdb.prisma.session.findMany({ where: { userId: "pw1" } })).toEqual([]);
  });

  it("먼저 같은 gmail 주소로 비밀번호 가입해 둔 사람은 Google 로그인 뒤 접근을 잃는다(선점 가입 차단)", async () => {
    await tdb.prisma.user.create({ data: { id: "pre", email: "victim@gmail.com", passwordHash: "attacker-hash" } });
    await tdb.prisma.session.create({ data: { id: "s-pre", userId: "pre", expiresAt: new Date(Date.now() + 60_000) } });
    const r = await upsertGoogleUser({ sub: "g-victim", email: "victim@gmail.com", name: null });
    expect(r).toEqual({ ok: true, userId: "pre", created: false, linked: true });
    expect(await user("pre")).toMatchObject({ googleSub: "g-victim", passwordHash: null });
    expect(await tdb.prisma.session.findMany({ where: { userId: "pre" } })).toEqual([]);
  });

  it("Google이 소유를 보증하지 않는 도메인(gmail 아님, hd 불일치)이면 연결하지 않는다", async () => {
    await tdb.prisma.user.create({ data: { id: "pw2", email: "alice@company.com", passwordHash: "h2" } });
    for (const hd of [undefined, "other.com"]) {
      expect(await upsertGoogleUser({ sub: "g-alice", email: "alice@company.com", name: null, hd })).toEqual({
        ok: false,
        reason: "unverified_email",
      });
    }
    expect(await user("pw2")).toMatchObject({ googleSub: null, passwordHash: "h2" });
  });

  it("이미 다른 Google 계정과 연결된 이메일이면 conflict", async () => {
    expect(await upsertGoogleUser({ sub: "g-3", email: "old@example.com", name: null, hd: "example.com" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect((await user("pw1"))!.googleSub).toBe("g-2");
  });

  it("google_sub는 유일하다", async () => {
    await expect(tdb.prisma.user.create({ data: { id: "dup", email: "dup@x.com", googleSub: "g-2" } })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
