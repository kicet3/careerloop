/** 회원 관리 API(PGlite): 관리자만, 목록·검색·탭 수, 승인·정지(세션 해제), 자기 자신·관리자 대상 거부. */
import { createHash } from "node:crypto";
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
let list: typeof import("./route");
let item: typeof import("./[id]/route");
let docs: typeof import("@/lib/legal/consents");

const ORIGIN = "http://localhost:3000";

async function seed(id: string, data: { status?: string; role?: string; email?: string; session?: boolean; googleSub?: string; passwordHash?: string } = {},
) {
  await tdb.prisma.user.create({
    data: {
      id,
      email: data.email ?? `${id}@x.com`,
      name: id.toUpperCase(),
      status: data.status ?? "approved",
      role: data.role ?? "user",
      googleSub: data.googleSub ?? null,
      passwordHash: data.passwordHash ?? null,
    },
  });
  await tdb.prisma.userConsent.createMany({
    data: docs.REQUIRED_CONSENT_TYPES.map((type) => ({ userId: id, type, version: docs.CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
  });
  if (data.session !== false) {
    await tdb.prisma.session.create({
      data: { id: createHash("sha256").update(`tok-${id}`).digest("hex"), userId: id, expiresAt: new Date(Date.now() + 20 * 86_400_000) },
    });
  }
}
const as = (id: string) => jar.set("rp_session", `tok-${id}`);
const patch = (id: string, action: string) =>
  item.PATCH(
    new Request(`${ORIGIN}/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
      headers: { origin: ORIGIN, host: "localhost:3000" },
    }),
    { params: Promise.resolve({ id }) },
  );

beforeAll(async () => {
  tdb = await createTestDb();
  docs = await import("@/lib/legal/consents");
  list = await import("./route");
  item = await import("./[id]/route");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  await tdb.reset();
  delete process.env.ADMIN_EMAILS;
  await seed("admin", { role: "admin" });
  await seed("admin2", { role: "admin" });
  await seed("p1", { status: "pending", email: "kim@corp.com" });
  await seed("p2", { status: "pending" });
  await seed("u1");
});

describe("GET /api/admin/users", () => {
  it("관리자가 아니면 403(admin_only), 로그인 안 하면 401", async () => {
    expect((await list.GET(new Request(`${ORIGIN}/api/admin/users`))).status).toBe(401);
    as("u1");
    const res = await list.GET(new Request(`${ORIGIN}/api/admin/users`));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "admin_only" });
  });

  it("탭별 목록·수, 검색", async () => {
    as("admin");
    const body = (await (await list.GET(new Request(`${ORIGIN}/api/admin/users`))).json()) as {
      users: { id: string; actions: string[] }[];
      total: number;
      counts: Record<string, number>;
    };
    expect(body.users.map((u) => u.id)).toEqual(["p1", "p2"]);
    expect(body.users[0]!.actions).toEqual(["approve", "reject"]);
    expect(body.counts).toEqual({ pending: 2, approved: 3, blocked: 0 });

    const found = (await (await list.GET(new Request(`${ORIGIN}/api/admin/users?tab=pending&q=CORP`))).json()) as { users: { id: string }[] };
    expect(found.users.map((u) => u.id)).toEqual(["p1"]);
  });

  it("ADMIN_EMAILS 사용자는 승인 대기여도 자동으로 관리자·승인이 된다", async () => {
    process.env.ADMIN_EMAILS = "Boss@x.com";
    await seed("boss", { status: "pending", email: "boss@x.com", googleSub: "g-boss" });
    as("boss");
    expect((await list.GET(new Request(`${ORIGIN}/api/admin/users`))).status).toBe(200);
    expect(await tdb.prisma.user.findUniqueOrThrow({ where: { id: "boss" } })).toMatchObject({ role: "admin", status: "approved" });
  });

  it("Google을 연결하지 않은 예전 비밀번호 계정은 ADMIN_EMAILS 이메일이어도 관리자로 올리지 않는다(이메일 미확인)", async () => {
    process.env.ADMIN_EMAILS = "boss@x.com";
    await seed("squat", { status: "approved", email: "boss@x.com", passwordHash: "h" });
    as("squat");
    const res = await list.GET(new Request(`${ORIGIN}/api/admin/users`));
    expect(res.status).toBe(403);
    expect(await tdb.prisma.user.findUniqueOrThrow({ where: { id: "squat" } })).toMatchObject({ role: "user", status: "approved" });
    // 확인되지 않은 계정은 관리자 보호도 받지 않는다 — 진짜 관리자가 정지할 수 있다.
    as("admin");
    expect((await patch("squat", "suspend")).status).toBe(200);
  });
});

describe("PATCH /api/admin/users/[id]", () => {
  it("승인하면 approved + 승인자 기록", async () => {
    as("admin");
    const res = await patch("p1", "approve");
    expect(res.status).toBe(200);
    expect(await tdb.prisma.user.findUniqueOrThrow({ where: { id: "p1" } })).toMatchObject({ status: "approved", approvedBy: "admin" });
  });

  it("정지하면 그 회원의 세션이 모두 지워지고, 정지 해제로 돌아온다", async () => {
    as("admin");
    expect((await patch("u1", "suspend")).status).toBe(200);
    expect(await tdb.prisma.session.count({ where: { userId: "u1" } })).toBe(0);
    expect((await patch("u1", "unsuspend")).status).toBe(200);
    expect((await tdb.prisma.user.findUniqueOrThrow({ where: { id: "u1" } })).status).toBe("approved");
  });

  it("자기 자신 400, 다른 관리자 정지 400, 없는 회원 404, 잘못된 전이 400, 알 수 없는 동작 400", async () => {
    as("admin");
    expect((await patch("admin", "suspend")).status).toBe(400);
    expect(await (await patch("admin2", "suspend")).json()).toMatchObject({ code: "target_admin" });
    expect((await patch("nobody", "approve")).status).toBe(404);
    expect((await patch("u1", "approve")).status).toBe(400);
    expect((await patch("u1", "delete")).status).toBe(400);
  });

  it("일반 회원은 403, 다른 출처는 403", async () => {
    as("u1");
    expect((await patch("p1", "approve")).status).toBe(403);
    as("admin");
    const res = await item.PATCH(
      new Request(`${ORIGIN}/api/admin/users/p1`, {
        method: "PATCH",
        body: JSON.stringify({ action: "approve" }),
        headers: { origin: "https://evil.example", host: "localhost:3000" },
      }),
      { params: Promise.resolve({ id: "p1" }) },
    );
    expect(res.status).toBe(403);
  });
});
