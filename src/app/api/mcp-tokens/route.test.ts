/** GET·POST /api/mcp-tokens, DELETE /api/mcp-tokens/[id] (PGlite, 세션은 가짜): 인증·출처·검증·상한·남의 토큰. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ userId: "u1" as string | null, crossSite: false }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () =>
    state.userId ? { id: state.userId, email: `${state.userId}@x.com`, name: null } : Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossSite ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));

let tdb: TestDb;
let list: typeof import("./route");
let item: typeof import("./[id]/route");

beforeAll(async () => {
  tdb = await createTestDb();
  list = await import("./route");
  item = await import("./[id]/route");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  state.userId = "u1";
  state.crossSite = false;
  for (const id of ["u1", "u2"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

const create = (body: unknown) =>
  list.POST(new Request("http://localhost/api/mcp-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const revoke = (id: string) => item.DELETE(new Request(`http://localhost/api/mcp-tokens/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

describe("/api/mcp-tokens", () => {
  it("만들기 → 201 원문 1회, 목록에는 원문·해시 없음", async () => {
    const res = await create({ name: "Claude Code", expiresInDays: 90 });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.token).toMatch(/^clp_/);
    expect(body.view).toMatchObject({ name: "Claude Code", status: "active" });
    const got = await (await list.GET()).json();
    expect(got.items).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain(body.token);
    expect(JSON.stringify(got)).not.toContain("tokenHash");
  });

  it("입력 검증: 빈 이름·허용 안 된 만료 → 400", async () => {
    expect((await create({ name: " ", expiresInDays: 90 })).status).toBe(400);
    expect((await create({ name: "a", expiresInDays: 7 })).status).toBe(400);
    expect((await create({ name: "a".repeat(41), expiresInDays: null })).status).toBe(400);
    expect((await create({ name: "a", expiresInDays: null })).status).toBe(201);
  });

  it("11번째는 409", async () => {
    for (let i = 0; i < 10; i++) expect((await create({ name: `t${i}`, expiresInDays: 30 })).status).toBe(201);
    const res = await create({ name: "over", expiresInDays: 30 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("토큰은 10개까지 만들 수 있습니다. 쓰지 않는 토큰을 폐기해 주세요.");
  });

  it("로그인 안 함 401, 다른 출처 403", async () => {
    state.userId = null;
    expect((await list.GET()).status).toBe(401);
    expect((await create({ name: "a", expiresInDays: 30 })).status).toBe(401);
    state.userId = "u1";
    state.crossSite = true;
    expect((await create({ name: "a", expiresInDays: 30 })).status).toBe(403);
    expect((await revoke("x")).status).toBe(403);
  });

  it("폐기: 내 토큰만, 남의 토큰·없는 id는 404", async () => {
    const { view } = await (await create({ name: "a", expiresInDays: 30 })).json();
    state.userId = "u2";
    expect((await revoke(view.id)).status).toBe(404);
    state.userId = "u1";
    const res = await revoke(view.id);
    expect(res.status).toBe(200);
    expect((await res.json()).view.status).toBe("revoked");
    expect((await revoke("mcp_nope")).status).toBe(404);
  });
});
