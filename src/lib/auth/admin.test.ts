/** 회원 관리(PGlite): 탭·검색, 허용 전이, 자기 자신·관리자 보호, 정지 시 세션 삭제·MCP 토큰 폐기, 동시 처리. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let admin: typeof import("./admin");

beforeAll(async () => {
  tdb = await createTestDb();
  admin = await import("./admin");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  delete process.env.ADMIN_EMAILS;
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  const rows = [
    { id: "boss", email: "boss@x.com", role: "admin", status: "approved" },
    { id: "adm2", email: "adm2@x.com", role: "admin", status: "approved" },
    { id: "p1", email: "kim@x.com", name: "김철수", status: "pending" },
    { id: "p2", email: "lee@x.com", name: "이영희", status: "pending" },
    { id: "u1", email: "u1@x.com", status: "approved" },
    { id: "r1", email: "r1@x.com", status: "rejected" },
    { id: "s1", email: "s1@x.com", status: "suspended" },
  ];
  for (const [i, r] of rows.entries()) await tdb.prisma.user.create({ data: { ...r, createdAt: new Date(t0 + i * 1000) } });
  await tdb.prisma.session.create({ data: { id: "sess-u1", userId: "u1", expiresAt: new Date(Date.now() + 86_400_000) } });
});

describe("목록", () => {
  it("탭별·검색, 승인 대기는 오래된 가입부터", async () => {
    const pending = await admin.listUsersForAdmin("boss", { tab: "pending" });
    expect(pending.total).toBe(2);
    expect(pending.users.map((u) => u.id)).toEqual(["p1", "p2"]);
    expect(pending.users[0]!.actions).toEqual(["approve", "reject"]);
    expect((await admin.listUsersForAdmin("boss", { tab: "blocked" })).users.map((u) => u.id).sort()).toEqual(["r1", "s1"]);
    expect((await admin.listUsersForAdmin("boss", { tab: "pending", q: "영희" })).users.map((u) => u.id)).toEqual(["p2"]);
    expect((await admin.listUsersForAdmin("boss", { tab: "pending", q: "KIM@" })).users.map((u) => u.id)).toEqual(["p1"]);
  });

  it("자기 자신·다른 관리자에게는 정지 동작이 없다", async () => {
    const approved = await admin.listUsersForAdmin("boss", { tab: "approved" });
    const by = Object.fromEntries(approved.users.map((u) => [u.id, u.actions]));
    expect(by).toEqual({ boss: [], adm2: [], u1: ["suspend"] });
  });

  it("탭별 수·대기 수", async () => {
    expect(await admin.countUsersByTab()).toEqual({ pending: 2, approved: 3, blocked: 2 });
    expect(await admin.countPendingUsers()).toBe(2);
  });
});

describe("상태 변경", () => {
  it("승인하면 승인 시각·승인자를 남긴다", async () => {
    const r = await admin.adminSetUserStatus("boss", "p1", "approve");
    expect(r).toMatchObject({ ok: true, user: { status: "approved", actions: ["suspend"] } });
    const row = await tdb.prisma.user.findUniqueOrThrow({ where: { id: "p1" } });
    expect(row.approvedBy).toBe("boss");
    expect(row.approvedAt).toBeInstanceOf(Date);
  });

  it("정지하면 세션을 모두 지우고 MCP 토큰을 폐기하며, 해제하면 승인으로 돌아온다", async () => {
    await tdb.prisma.mcpToken.createMany({
      data: [
        { id: "mcp_u1", userId: "u1", name: "a", tokenHash: "h1", prefix: "clp_11111111" },
        { id: "mcp_boss", userId: "boss", name: "b", tokenHash: "h2", prefix: "clp_22222222" },
      ],
    });
    expect((await admin.adminSetUserStatus("boss", "u1", "suspend")).ok).toBe(true);
    expect(await tdb.prisma.session.count({ where: { userId: "u1" } })).toBe(0);
    expect((await tdb.prisma.mcpToken.findUniqueOrThrow({ where: { id: "mcp_u1" } })).revokedAt).toBeInstanceOf(Date);
    expect((await tdb.prisma.mcpToken.findUniqueOrThrow({ where: { id: "mcp_boss" } })).revokedAt).toBeNull();
    expect(await admin.adminSetUserStatus("boss", "u1", "unsuspend")).toMatchObject({ ok: true, user: { status: "approved" } });
  });

  it("자기 자신·관리자·허용되지 않은 전이·없는 회원은 거절", async () => {
    expect(await admin.adminSetUserStatus("boss", "boss", "suspend")).toMatchObject({ ok: false, reason: "self" });
    expect(await admin.adminSetUserStatus("boss", "adm2", "suspend")).toMatchObject({ ok: false, reason: "target_admin" });
    expect(await admin.adminSetUserStatus("boss", "u1", "approve")).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect(await admin.adminSetUserStatus("boss", "nope", "approve")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("ADMIN_EMAILS에 있는(Google로 확인된) 계정은 role이 user여도 정지할 수 없다", async () => {
    process.env.ADMIN_EMAILS = "u1@x.com";
    await tdb.prisma.user.update({ where: { id: "u1" }, data: { googleSub: "g-u1" } });
    expect(await admin.adminSetUserStatus("boss", "u1", "suspend")).toMatchObject({ ok: false, reason: "target_admin" });
  });

  it("Google을 연결하지 않은(이메일 미확인) ADMIN_EMAILS 계정은 보호하지 않는다", async () => {
    process.env.ADMIN_EMAILS = "u1@x.com";
    expect(await admin.adminSetUserStatus("boss", "u1", "suspend")).toMatchObject({ ok: true });
  });

  it("동시에 처리하면 한쪽만 반영된다", async () => {
    const results = await Promise.all([admin.adminSetUserStatus("boss", "p2", "approve"), admin.adminSetUserStatus("adm2", "p2", "reject")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
