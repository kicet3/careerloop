/**
 * 에이전트 라우트: 로그인(401)·같은 출처(403)·남의 작업(404)·no-store, 사용자 이어 가기(리스가 살아 있으면 예약 안 함),
 * 내부 연쇄(비밀 없으면 404, 서명 위조·만료·다른 runId는 401, 맞으면 202 + 그 행의 userId로만 실행).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string | null } | null,
  afterTasks: [] as (() => unknown)[],
  advanced: [] as { jobId: string; opts: unknown }[],
}));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: (req: Request) => (req.headers.get("origin") === "https://evil.example" ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/graph/service", () => ({ graphEnabled: () => true, getCareerGraph: async () => ({ person: { id: "me", name: null }, nodes: [], edges: [] }), graphToText: () => "" }));
vi.mock("./jobs", async (orig) => {
  const real = await orig<typeof import("./jobs")>();
  return {
    ...real,
    advanceAgentJob: async (jobId: string, opts: unknown) => {
      state.advanced.push({ jobId, opts });
    },
  };
});

let tdb: TestDb;
let jobRoute: typeof import("@/app/api/resumes/agent-jobs/[id]/route");
let advanceRoute: typeof import("@/app/api/resumes/agent-jobs/[id]/advance/route");
let cancelRoute: typeof import("@/app/api/resumes/agent-jobs/[id]/cancel/route");
let retryRoute: typeof import("@/app/api/resumes/agent-jobs/[id]/retry/route");
let internalRoute: typeof import("@/app/api/internal/resume-agent/advance/route");
let chain: typeof import("./chain");

const SECRET = "k".repeat(48);

beforeAll(async () => {
  delete process.env.RESUME_AGENT_CHAIN_SECRET;
  tdb = await createTestDb();
  jobRoute = await import("@/app/api/resumes/agent-jobs/[id]/route");
  advanceRoute = await import("@/app/api/resumes/agent-jobs/[id]/advance/route");
  cancelRoute = await import("@/app/api/resumes/agent-jobs/[id]/cancel/route");
  retryRoute = await import("@/app/api/resumes/agent-jobs/[id]/retry/route");
  internalRoute = await import("@/app/api/internal/resume-agent/advance/route");
  chain = await import("./chain");
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  delete process.env.RESUME_AGENT_CHAIN_SECRET;
  state.user = { id: "ua", email: "ua@x.com", name: null };
  state.afterTasks = [];
  state.advanced = [];
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  await tdb.prisma.resumeAgentJob.create({
    data: { id: "job1", userId: "ua", runId: "run1", status: "waiting", label: "토스 · 백엔드", input: { kind: "company", company: "토스", roleTitle: "백엔드", jdText: "", templateId: "developer", title: "", source: { kind: "graph" } } },
  });
});

const ctx = (id = "job1") => ({ params: Promise.resolve({ id }) });
const req = (method: string, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method, headers });
async function flush() {
  while (state.afterTasks.length) await state.afterTasks.shift()!();
}

describe("사용자 라우트", () => {
  it("로그인이 없으면 401", async () => {
    state.user = null;
    expect((await jobRoute.GET(req("GET"), ctx())).status).toBe(401);
    expect((await advanceRoute.POST(req("POST"), ctx())).status).toBe(401);
    expect((await cancelRoute.POST(req("POST"), ctx())).status).toBe(401);
    expect((await retryRoute.POST(req("POST"), ctx())).status).toBe(401);
  });

  it("다른 출처의 변경 요청은 403(조회는 같은 출처 검사 없음)", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await advanceRoute.POST(req("POST", evil), ctx())).status).toBe(403);
    expect((await cancelRoute.POST(req("POST", evil), ctx())).status).toBe(403);
    expect((await retryRoute.POST(req("POST", evil), ctx())).status).toBe(403);
    expect(state.advanced).toHaveLength(0);
  });

  it("남의 작업은 404, 내 작업은 no-store", async () => {
    state.user = { id: "ub", email: "ub@x.com", name: null };
    for (const res of [await jobRoute.GET(req("GET"), ctx()), await advanceRoute.POST(req("POST"), ctx()), await cancelRoute.POST(req("POST"), ctx()), await retryRoute.POST(req("POST"), ctx())]) {
      expect(res.status).toBe(404);
    }
    state.user = { id: "ua", email: "ua@x.com", name: null };
    const res = await jobRoute.GET(req("GET"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const view = ((await res.json()) as { agentJob: Record<string, unknown> }).agentJob;
    expect(view).not.toHaveProperty("input");
    expect(view).not.toHaveProperty("userId");
  });

  it("이어 가기: 리스가 비어 있으면 세션 userId로 예약, 살아 있으면 no-op(202, scheduled false)", async () => {
    const res = await advanceRoute.POST(req("POST"), ctx());
    expect(res.status).toBe(202);
    await flush();
    expect(state.advanced).toEqual([{ jobId: "job1", opts: expect.objectContaining({ userId: "ua" }) }]);
    await tdb.prisma.resumeAgentJob.update({ where: { id: "job1" }, data: { status: "running", leaseId: "L", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    state.advanced = [];
    const busy = await advanceRoute.POST(req("POST"), ctx());
    expect(((await busy.json()) as { scheduled: boolean }).scheduled).toBe(false);
    await flush();
    expect(state.advanced).toHaveLength(0);
  });

  it("취소: 진행 중이면 canceled + 리스 해제, 완성된 작업은 409", async () => {
    const res = await cancelRoute.POST(req("POST"), ctx());
    expect(((await res.json()) as { agentJob: { status: string } }).agentJob.status).toBe("canceled");
    await tdb.prisma.resumeAgentJob.update({ where: { id: "job1" }, data: { status: "completed" } });
    expect((await cancelRoute.POST(req("POST"), ctx())).status).toBe(409);
  });

  it("다시 시도: 진행 중인 작업은 409", async () => {
    expect((await retryRoute.POST(req("POST"), ctx())).status).toBe(409);
  });
});

describe("내부 연쇄 라우트", () => {
  const call = (body: unknown, sig: string) =>
    internalRoute.POST(new Request("http://localhost/api/internal/resume-agent/advance", { method: "POST", headers: { "Content-Type": "application/json", [chain.CHAIN_SIGNATURE_HEADER]: sig }, body: JSON.stringify(body) }));

  it("비밀이 없는 배포는 404(존재도 숨김)", async () => {
    const exp = Date.now() + 60_000;
    expect((await call({ jobId: "job1", runId: "run1", exp }, chain.signAdvance(SECRET, "job1", "run1", exp))).status).toBe(404);
  });

  it("서명 위조·만료·다른 runId는 401, 본문은 비어 있다", async () => {
    process.env.RESUME_AGENT_CHAIN_SECRET = SECRET;
    const exp = Date.now() + 60_000;
    const forged = await call({ jobId: "job1", runId: "run1", exp }, chain.signAdvance("x".repeat(48), "job1", "run1", exp));
    expect(forged.status).toBe(401);
    expect(await forged.text()).toBe("");
    const old = Date.now() - 120_000; // 시계 오차 허용(60초)을 넘겨 만료된 서명
    expect((await call({ jobId: "job1", runId: "run1", exp: old }, chain.signAdvance(SECRET, "job1", "run1", old))).status).toBe(401);
    expect((await call({ jobId: "job1", runId: "run2", exp }, chain.signAdvance(SECRET, "job1", "run1", exp))).status).toBe(401);
    expect(state.advanced).toHaveLength(0);
  });

  it("맞는 서명이면 202 — 행을 jobId·runId·진행 상태로 찾아 runId 조건으로 실행(본문 userId는 받지 않는다)", async () => {
    process.env.RESUME_AGENT_CHAIN_SECRET = SECRET;
    const exp = Date.now() + 60_000;
    const res = await call({ jobId: "job1", runId: "run1", exp, userId: "ub" }, chain.signAdvance(SECRET, "job1", "run1", exp));
    expect(res.status).toBe(202);
    await flush();
    expect(state.advanced).toEqual([{ jobId: "job1", opts: expect.objectContaining({ runId: "run1", userId: undefined }) }]);
    // 이미 다른 runId로 다시 시작한 작업(예전 실행의 서명)은 404.
    await tdb.prisma.resumeAgentJob.update({ where: { id: "job1" }, data: { runId: "run9" } });
    expect((await call({ jobId: "job1", runId: "run1", exp }, chain.signAdvance(SECRET, "job1", "run1", exp))).status).toBe(404);
  });
});
