/** 토큰 사용량 API·화면(PGlite): 관리자만(API 401/403, 화면 404), 회원별 합계·비용 순 정렬·기간 필터·작업별·회원 상세. */
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
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

let tdb: TestDb;
let route: typeof import("./route");
let docs: typeof import("@/lib/legal/consents");

const ORIGIN = "http://localhost:3000";
const DAY = 86_400_000;

async function seed(id: string, data: { role?: string; name?: string } = {}) {
  await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: data.name ?? id.toUpperCase(), status: "approved", role: data.role ?? "user" } });
  await tdb.prisma.userConsent.createMany({
    data: docs.REQUIRED_CONSENT_TYPES.map((type) => ({ userId: id, type, version: docs.CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
  });
  await tdb.prisma.session.create({
    data: { id: createHash("sha256").update(`tok-${id}`).digest("hex"), userId: id, expiresAt: new Date(Date.now() + 20 * DAY) },
  });
}
const as = (id: string) => jar.set("rp_session", `tok-${id}`);

async function event(userId: string | null, data: { task?: string; stage?: string; input?: number; output?: number; cost?: number | null; ok?: boolean; ageDays?: number; provider?: string }) {
  await tdb.prisma.llmUsageEvent.create({
    data: {
      userId,
      task: data.task ?? "graph-chat",
      stage: data.stage ?? null,
      provider: data.provider ?? "anthropic",
      model: "claude-opus-5-5",
      inputTokens: data.input ?? 100,
      outputTokens: data.output ?? 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicroUsd: data.cost === null ? null : BigInt(data.cost ?? 1000),
      ok: data.ok ?? true,
      createdAt: new Date(Date.now() - (data.ageDays ?? 0) * DAY),
    },
  });
}

const get = (qs = "") => route.GET(new Request(`${ORIGIN}/api/admin/usage${qs}`));

beforeAll(async () => {
  tdb = await createTestDb();
  // PGlite는 호스트 시간대(예: Asia/Seoul)를 세션 시간대로 쓰고, pglite 어댑터는 Date를 오프셋 없이 보내 그 시간대로 해석된다.
  // 운영·개발 Postgres(UTC)와 같게 맞춰 한국 시간 날짜 경계를 정확히 본다.
  await tdb.pglite.exec("SET TIME ZONE 'UTC'");
  docs = await import("@/lib/legal/consents");
  route = await import("./route");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  await tdb.reset();
  delete process.env.ADMIN_EMAILS;
  await seed("admin", { role: "admin" });
  await seed("u1");
  await seed("u2");
  await event("u1", { cost: 1000, input: 100, output: 10 });
  await event("u1", { task: "diagnosis", stage: "ats", cost: 2000, input: 200, output: 20, ok: false });
  await event("u2", { cost: 5000, input: 50, output: 5 });
  await event("u2", { provider: "claude-cli", cost: null, input: 1, output: 1 });
  await event("u1", { cost: 9000, ageDays: 40 }); // 30일 밖
  await event(null, { task: "posting-extract", cost: 100 });
});

describe("접근 권한", () => {
  it("API: 로그인 안 하면 401, 관리자가 아니면 403(admin_only)", async () => {
    expect((await get()).status).toBe(401);
    as("u1");
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "admin_only" });
  });

  it("화면: 관리자가 아니면 404, 로그인 안 하면 로그인으로", async () => {
    const page = (await import("@/app/app/admin/usage/page")).default;
    const detail = (await import("@/app/app/admin/usage/[userId]/page")).default;
    const sp = Promise.resolve({});
    await expect(page({ searchParams: sp })).rejects.toThrow("REDIRECT:/login");
    as("u1");
    await expect(page({ searchParams: sp })).rejects.toThrow("NOT_FOUND");
    await expect(detail({ params: Promise.resolve({ userId: "u1" }), searchParams: sp })).rejects.toThrow("NOT_FOUND");
    as("admin");
    await expect(page({ searchParams: sp })).resolves.toBeTruthy();
    await expect(detail({ params: Promise.resolve({ userId: "u1" }), searchParams: sp })).resolves.toBeTruthy();
  });
});

describe("집계", () => {
  it("기본(30일): 회원별 합계를 추정 비용 순으로, 전체 합계·작업별", async () => {
    as("admin");
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe("30d");
    expect(body.users.map((u: { userId: string | null }) => u.userId)).toEqual(["u2", "u1", null]);
    expect(body.users[0]).toMatchObject({ email: "u2@x.com", name: "U2", calls: 2, costMicroUsd: 5000, unpricedCalls: 1, inputTokens: 51 });
    expect(body.users[1]).toMatchObject({ calls: 2, failedCalls: 1, costMicroUsd: 3000, inputTokens: 300, outputTokens: 30 });
    expect(body.totals).toMatchObject({ calls: 5, failedCalls: 1, costMicroUsd: 8100, unpricedCalls: 1 });
    const tasks = Object.fromEntries(body.byTask.map((t: { key: string; calls: number }) => [t.key, t.calls]));
    expect(tasks).toEqual({ "graph-chat": 3, diagnosis: 1, "posting-extract": 1 });
  });

  it("기간: 오늘 < 7일 < 전체(한국 시간 자정 기준)", async () => {
    as("admin");
    await event("u2", { cost: 1, ageDays: 3 });
    const calls = async (p: string) => (await (await get(`?period=${p}`)).json()).totals.calls;
    expect(await calls("today")).toBe(5);
    expect(await calls("7d")).toBe(6);
    expect(await calls("30d")).toBe(6);
    expect(await calls("all")).toBe(7);
    const all = await (await get("?period=all")).json();
    expect(all.users[0]).toMatchObject({ userId: "u1", costMicroUsd: 12000 });
  });

  it("날짜별 묶음은 한국 시간 날짜다(UTC 15:00 이후는 다음 날)", async () => {
    const at = (iso: string) =>
      tdb.prisma.llmUsageEvent.create({
        data: { userId: "admin", task: "graph-qa", provider: "anthropic", model: "claude-opus-5-5", ok: true, costMicroUsd: BigInt(1), createdAt: new Date(iso) },
      });
    await at("2026-11-06T14:59:00Z"); // KST 11-06 23:59
    await at("2026-11-06T15:30:00Z"); // KST 11-07 00:30
    const { listUsageByDay } = await import("@/lib/llm/usage-report");
    // 사용량이 없는 관리자 계정에만 넣어 날짜 묶음을 정확히 본다.
    const days = await listUsageByDay({ since: null, userId: "admin" });
    expect(days.map((d) => [d.key, d.calls])).toEqual([
      ["2026-11-07", 1],
      ["2026-11-06", 1],
    ]);
    // since가 KST 11-07 자정이면 11-06 23:59 행은 빠진다.
    const after = await listUsageByDay({ since: new Date("2026-11-06T15:00:00Z"), userId: "admin" });
    expect(after.map((d) => d.key)).toEqual(["2026-11-07"]);
  });

  it("회원 상세: 작업(심사 단계 포함)·날짜·모델별, 없는 회원 404", async () => {
    as("admin");
    const body = await (await get("?userId=u1")).json();
    expect(body.user).toMatchObject({ id: "u1", email: "u1@x.com" });
    expect(body.totals).toMatchObject({ calls: 2, costMicroUsd: 3000 });
    expect(body.byTask.map((t: { key: string }) => t.key)).toEqual(["diagnosis:ats", "graph-chat"]);
    expect(body.byDay).toHaveLength(1);
    expect(body.byModel[0]).toMatchObject({ key: "anthropic · claude-opus-5-5", calls: 2 });
    expect((await get("?userId=nobody")).status).toBe(404);
  });
});
