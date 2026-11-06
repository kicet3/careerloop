/** MCP 토큰 저장소(PGlite): 원문 1회·해시 저장, 상한 10개, 목록(폐기 30일), 폐기, 조회, 마지막 사용 간격, 탈퇴 CASCADE. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let tokens: typeof import("./tokens");
const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-06T00:00:00Z");

beforeAll(async () => {
  tdb = await createTestDb();
  tokens = await import("./tokens");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  await tdb.prisma.user.create({ data: { id: "u1", email: "u1@x.com", name: "홍길동", status: "approved" } });
  await tdb.prisma.user.create({ data: { id: "u2", email: "u2@x.com", status: "approved" } });
});

describe("createMcpToken", () => {
  it("원문은 응답에만, DB에는 해시·앞 12자", async () => {
    const { token, view } = await tokens.createMcpToken("u1", { name: " Claude Code ", expiresInDays: 90 }, NOW);
    expect(token).toMatch(/^clp_[A-Za-z0-9_-]{43}$/);
    expect(view).toMatchObject({ name: "Claude Code", prefix: token.slice(0, 12), scopes: ["graph:read"], status: "active", lastUsedAt: null });
    expect(view.expiresAt).toBe(NOW + 90 * DAY);
    const row = await tdb.prisma.mcpToken.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.tokenHash).toBe(tokens.hashMcpToken(token));
    expect(row.tokenHash).not.toContain(token.slice(4));
    expect(row.kind).toBe("pat");
    expect(row.id).toMatch(/^mcp_/);
  });

  it("만료 없음(null)", async () => {
    const { view } = await tokens.createMcpToken("u1", { name: "x", expiresInDays: null }, NOW);
    expect(view.expiresAt).toBeNull();
  });

  it("활성 토큰 10개면 409 — 폐기·만료한 토큰은 세지 않는다", async () => {
    const made = [];
    for (let i = 0; i < 10; i++) made.push(await tokens.createMcpToken("u1", { name: `t${i}`, expiresInDays: 30 }, NOW));
    await expect(tokens.createMcpToken("u1", { name: "over", expiresInDays: 30 }, NOW)).rejects.toMatchObject({ status: 409 });
    // 다른 사용자는 따로 센다.
    await expect(tokens.createMcpToken("u2", { name: "ok", expiresInDays: 30 }, NOW)).resolves.toBeTruthy();
    await tokens.revokeMcpToken("u1", made[0]!.view.id, NOW);
    await expect(tokens.createMcpToken("u1", { name: "again", expiresInDays: 30 }, NOW)).resolves.toBeTruthy();
    // 31일 뒤에는 30일 토큰이 모두 만료 — 다시 만들 수 있다.
    await expect(tokens.createMcpToken("u1", { name: "later", expiresInDays: 30 }, NOW + 31 * DAY)).resolves.toBeTruthy();
  });

  it("동시에 만들어도 상한을 넘지 않는다", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 14 }, (_, i) => tokens.createMcpToken("u1", { name: `c${i}`, expiresInDays: 30 }, NOW)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  });
});

describe("목록·폐기", () => {
  it("내 토큰만, 최근 순, 폐기한 지 30일 지난 것은 숨긴다, 상태 표시", async () => {
    const a = await tokens.createMcpToken("u1", { name: "a", expiresInDays: 30 }, NOW - 40 * DAY);
    const b = await tokens.createMcpToken("u1", { name: "b", expiresInDays: 90 }, NOW - 20 * DAY);
    const c = await tokens.createMcpToken("u1", { name: "c", expiresInDays: null }, NOW - 10 * DAY);
    await tokens.createMcpToken("u2", { name: "other", expiresInDays: null }, NOW);
    await tokens.revokeMcpToken("u1", b.view.id, NOW - 31 * DAY + DAY * 12); // 19일 전 폐기 → 보인다
    const old = await tokens.createMcpToken("u1", { name: "old", expiresInDays: null }, NOW - 50 * DAY);
    await tokens.revokeMcpToken("u1", old.view.id, NOW - 45 * DAY); // 45일 전 폐기 → 숨김
    const list = await tokens.listMcpTokens("u1", NOW);
    expect(list.map((t) => [t.name, t.status])).toEqual([
      ["c", "active"],
      ["b", "revoked"],
      ["a", "expired"],
    ]);
    expect(list.some((t) => t.id === a.view.id)).toBe(true);
    expect(c.view.status).toBe("active");
  });

  it("다른 사람 토큰은 폐기할 수 없다(null), 다시 폐기해도 그대로", async () => {
    const t = await tokens.createMcpToken("u1", { name: "a", expiresInDays: 30 }, NOW);
    expect(await tokens.revokeMcpToken("u2", t.view.id, NOW)).toBeNull();
    const first = await tokens.revokeMcpToken("u1", t.view.id, NOW + 1000);
    const second = await tokens.revokeMcpToken("u1", t.view.id, NOW + 5000);
    expect(first?.revokedAt).toBe(NOW + 1000);
    expect(second?.revokedAt).toBe(NOW + 1000);
  });

  it("revokeAllMcpTokens는 그 사용자의 활성 토큰만", async () => {
    await tokens.createMcpToken("u1", { name: "a", expiresInDays: 30 }, NOW);
    await tokens.createMcpToken("u1", { name: "b", expiresInDays: 30 }, NOW);
    await tokens.createMcpToken("u2", { name: "c", expiresInDays: 30 }, NOW);
    expect(await tokens.revokeAllMcpTokens("u1")).toBe(2);
    expect(await tdb.prisma.mcpToken.count({ where: { revokedAt: null } })).toBe(1);
  });
});

describe("조회·마지막 사용", () => {
  it("원문으로 찾고(사용자 상태 포함), 모르는 원문은 null", async () => {
    const { token, view } = await tokens.createMcpToken("u1", { name: "a", expiresInDays: 30 }, NOW);
    const found = await tokens.findMcpToken(token);
    expect(found).toMatchObject({ id: view.id, prefix: view.prefix, user: { id: "u1", name: "홍길동", status: "approved" } });
    expect(await tokens.findMcpToken(`${token}x`)).toBeNull();
  });

  it("last_used_at은 5분 간격으로만 쓴다", async () => {
    const { view } = await tokens.createMcpToken("u1", { name: "a", expiresInDays: 30 }, NOW);
    await tokens.touchMcpToken(view.id, null, NOW);
    const at = async () => (await tdb.prisma.mcpToken.findUniqueOrThrow({ where: { id: view.id } })).lastUsedAt?.getTime();
    expect(await at()).toBe(NOW);
    await tokens.touchMcpToken(view.id, new Date(NOW), NOW + 60_000);
    expect(await at()).toBe(NOW);
    // 호출자가 오래된 값을 들고 와도 DB 조건이 막는다.
    await tokens.touchMcpToken(view.id, null, NOW + 60_000);
    expect(await at()).toBe(NOW);
    await tokens.touchMcpToken(view.id, new Date(NOW), NOW + 6 * 60_000);
    expect(await at()).toBe(NOW + 6 * 60_000);
  });

  it("사용자를 지우면 토큰도 지워진다(FK CASCADE)", async () => {
    await tokens.createMcpToken("u1", { name: "a", expiresInDays: 30 }, NOW);
    await tdb.prisma.user.delete({ where: { id: "u1" } });
    expect(await tdb.prisma.mcpToken.count()).toBe(0);
  });
});
