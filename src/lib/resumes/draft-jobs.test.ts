/**
 * AI 이력서 초안 작업(PGlite + 로컬 저장소 + 가짜 LLM, 세션은 가짜): POST /api/resumes(AI) → 202 + after() 예약 → 실행 → 완료·알림,
 * 실패 → 'failed' + 알림 → 다시 시도, 멈춘 작업 닫기, 버려진 실행, 남의 작업 404, 동시 작업 상한, 목록.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@/lib/llm";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-draft-jobs-")), "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "홍길동", role: "user" } as { id: string; email: string; name: string | null } | null,
  afterTasks: [] as (() => unknown)[],
  client: null as unknown,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
vi.mock("@/lib/llm", async (orig) => ({ ...(await orig<typeof import("@/lib/llm")>()), createLlmClient: () => state.client }));

let tdb: TestDb;
let jobs: typeof import("./draft-jobs");
let resumesRoute: typeof import("@/app/api/resumes/route");
let jobRoute: typeof import("@/app/api/resumes/drafts/[id]/route");
let retryRoute: typeof import("@/app/api/resumes/drafts/[id]/retry/route");
let listRoute: typeof import("@/app/api/resumes/drafts/route");
let notificationsRoute: typeof import("@/app/api/notifications/route");
let FakeLlmClient: typeof import("@/test/fake-llm").FakeLlmClient;
let LlmPermanentError: typeof import("@/lib/llm").LlmPermanentError;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL"]) delete process.env[k];
  tdb = await createTestDb();
  jobs = await import("./draft-jobs");
  resumesRoute = await import("@/app/api/resumes/route");
  jobRoute = await import("@/app/api/resumes/drafts/[id]/route");
  retryRoute = await import("@/app/api/resumes/drafts/[id]/retry/route");
  listRoute = await import("@/app/api/resumes/drafts/route");
  notificationsRoute = await import("@/app/api/notifications/route");
  ({ FakeLlmClient } = await import("@/test/fake-llm"));
  ({ LlmPermanentError } = await import("@/lib/llm"));
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
  state.afterTasks = [];
  state.client = new FakeLlmClient();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: id === "ua" ? "홍길동" : null, status: "approved" } });
  await tdb.prisma.diagnosis.create({
    data: { id: "d1", userId: "ua", title: "백엔드 진단", targetRole: "백엔드", situation: "general", resumeText: "원본", model: "m", status: "done" },
  });
  await tdb.prisma.diagnosisStage.create({
    data: {
      diagnosisId: "d1",
      stage: "rewrite",
      status: "done",
      output: { resumeMarkdown: "홍길동\n결제 API 응답 시간 40% 단축\n정산 배치 재작성", changes: [], addQuestions: [], assumptions: [] },
    },
  });
  await tdb.prisma.diagnosis.create({
    data: { id: "d2", userId: "ua", title: "진행 중", targetRole: "백엔드", situation: "general", resumeText: "원본", model: "m", status: "running" },
  });
});

const draftBody = (extra: Record<string, unknown> = {}) => ({
  company: "페이랩",
  roleTitle: "백엔드",
  jdText: "Kotlin 경험자",
  templateId: "developer",
  source: { kind: "diagnosis", diagnosisId: "d1" },
  ...extra,
});
const post = (body: unknown) =>
  resumesRoute.POST(new Request("http://localhost/api/resumes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const getJob = (id: string) => jobRoute.GET(new Request(`http://localhost/api/resumes/drafts/${id}`), ctx(id));
const retry = (id: string) => retryRoute.POST(new Request(`http://localhost/api/resumes/drafts/${id}/retry`, { method: "POST" }), ctx(id));
async function runAfter() {
  const tasks = state.afterTasks.splice(0);
  for (const t of tasks) await t();
}
async function startJob(): Promise<string> {
  const res = await post(draftBody());
  expect(res.status).toBe(202);
  return ((await res.json()) as { draftJob: { id: string } }).draftJob.id;
}
const failingClient = (): LlmClient => ({
  name: "fail",
  generate: async () => {
    throw new LlmPermanentError("거절", "refusal");
  },
});

describe("AI 초안 작업", () => {
  it("POST는 바로 202(진행 중)로 돌아가고, 백그라운드 실행이 이력서를 만들고 완료 알림을 남긴다", async () => {
    const res = await post(draftBody());
    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { draftJob } = (await res.json()) as { draftJob: import("./draft-job-types").ResumeDraftJobView };
    expect(draftJob).toMatchObject({ status: "running", stage: "material", label: "페이랩 · 백엔드", resumeId: null });
    expect(state.afterTasks).toHaveLength(1);
    // 아직 실행 전: 이력서는 없다.
    expect(await tdb.prisma.companyResume.count()).toBe(0);

    await runAfter();
    const view = ((await (await getJob(draftJob.id)).json()) as { draftJob: import("./draft-job-types").ResumeDraftJobView }).draftJob;
    expect(view.status).toBe("completed");
    expect(view.resumeId).toBeTruthy();
    expect(view.missingInfo.length).toBeGreaterThan(0);
    const resume = await tdb.prisma.companyResume.findUniqueOrThrow({ where: { id: view.resumeId! }, include: { versions: true } });
    expect(resume).toMatchObject({ userId: "ua", company: "페이랩", roleTitle: "백엔드" });
    expect(resume.versions[0]!.source).toBe("ai");
    // 완료하면 입력(JD 포함)은 지운다.
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: draftJob.id } })).input).toBeNull();
    const notes = await tdb.prisma.notification.findMany({ where: { userId: "ua" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "resume-draft-completed", link: `/app/resumes/${view.resumeId}`, readAt: null });
  });

  it("단계를 차례로 쓴다(자료 → 초안 → 저장)", async () => {
    const id = await startJob();
    const stages: string[] = [];
    const fake = new FakeLlmClient();
    state.client = {
      name: "spy",
      generate: async (req: Parameters<LlmClient["generate"]>[0]) => {
        stages.push((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).stage);
        return fake.generate(req);
      },
    } as LlmClient;
    await runAfter();
    expect(stages).toEqual(["writing"]);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).stage).toBe("saving");
  });

  it("실패하면 'failed' + 문구 + 실패 알림, 다시 시도하면 새 실행으로 완료한다", async () => {
    state.client = failingClient();
    const id = await startJob();
    await runAfter();
    const failed = ((await (await getJob(id)).json()) as { draftJob: import("./draft-job-types").ResumeDraftJobView }).draftJob;
    expect(failed).toMatchObject({ status: "failed", canRetry: true });
    expect(failed.error).toContain("거절");
    expect(await tdb.prisma.companyResume.count()).toBe(0);
    const n = await tdb.prisma.notification.findFirstOrThrow({ where: { userId: "ua" } });
    expect(n).toMatchObject({ kind: "resume-draft-failed", link: `/app/resumes/drafts/${id}` });

    state.client = new FakeLlmClient();
    const again = await retry(id);
    expect(again.status).toBe(202);
    expect(((await again.json()) as { draftJob: { status: string; attempts: number } }).draftJob).toMatchObject({ status: "running", attempts: 2 });
    // 진행 중에 또 누르면 409.
    expect((await retry(id)).status).toBe(409);
    await runAfter();
    const done = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe("completed");
    expect(await tdb.prisma.companyResume.count()).toBe(1);
    // 완성된 작업은 다시 시도할 수 없다.
    expect((await retry(id)).status).toBe(409);
  });

  it("남의 작업은 조회·다시 시도 모두 404, 로그인이 없으면 401", async () => {
    const id = await startJob();
    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await getJob(id)).status).toBe(404);
    expect((await retry(id)).status).toBe(404);
    expect(((await (await listRoute.GET()).json()) as { items: unknown[] }).items).toEqual([]);
    state.user = null;
    expect((await getJob(id)).status).toBe(401);
    expect((await post(draftBody())).status).toBe(401);
  });

  it("자료 문제는 요청 안에서 바로 거절하고 작업을 만들지 않는다", async () => {
    expect((await post(draftBody({ source: { kind: "diagnosis", diagnosisId: "d2" } }))).status).toBe(409);
    expect((await post(draftBody({ source: { kind: "diagnosis", diagnosisId: "nope" } }))).status).toBe(404);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
    expect(state.afterTasks).toHaveLength(0);
  });

  it("빈 문서는 그대로 바로 만든다(201, 작업 없음)", async () => {
    const res = await post(draftBody({ source: { kind: "blank" } }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBeTruthy();
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
  });

  it("동시에 진행할 수 있는 초안은 3개까지", async () => {
    for (let i = 0; i < jobs.MAX_ACTIVE_DRAFT_JOBS; i++) await startJob();
    const res = await post(draftBody());
    expect(res.status).toBe(409);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(jobs.MAX_ACTIVE_DRAFT_JOBS);
  });

  it("멈춘 작업(시작 후 상한 + 여유가 지남)은 읽을 때 실패로 닫고 알림을 남긴다 — 다시 시도할 수 있다", async () => {
    const id = await startJob();
    state.afterTasks = []; // after()가 죽었다고 본다.
    await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { startedAt: new Date(Date.now() - jobs.draftStaleMs() - 1000) } });
    const list = ((await (await listRoute.GET()).json()) as { items: { id: string; status: string }[] }).items;
    expect(list).toEqual([expect.objectContaining({ id, status: "failed" })]);
    const view = await jobs.getDraftJob("ua", id);
    expect(view).toMatchObject({ status: "failed", canRetry: true });
    expect(await tdb.prisma.notification.count({ where: { userId: "ua", kind: "resume-draft-failed" } })).toBe(1);
    expect((await retry(id)).status).toBe(202);
  });

  it("실행 전에 실패로 닫힌 작업은 실행하지 않는다", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { status: "failed", error: "끊김" } });
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => new FakeLlmClient() });
    expect(await tdb.prisma.companyResume.count()).toBe(0);
  });

  it("초안을 쓰는 동안 멈춤 판정으로 닫히면 늦게 온 결과는 버린다(실패로 남고, 실패 알림 뒤 완료 알림이 가지 않는다)", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    const fake = new FakeLlmClient();
    const client = {
      name: "late",
      generate: async (req: Parameters<LlmClient["generate"]>[0]) => {
        await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { status: "failed", error: "끊김", stage: "saving" } });
        return fake.generate(req);
      },
    } as LlmClient;
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => client });
    // 저장 단계로 넘어가는 쓰기가 막혀 이 실행은 멈춘다(이력서를 만들지 않는다) — 다시 시도로 이어 간다.
    expect(await tdb.prisma.companyResume.count()).toBe(0);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
    expect(await tdb.prisma.notification.count({ where: { userId: "ua", kind: "resume-draft-completed" } })).toBe(0);
  });

  it("저장한 뒤 완료 기록 전에 runId가 바뀌면(다시 시도) 이 실행이 만든 이력서를 지운다", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    let saved: string | null = null;
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", {
      createClient: () => new FakeLlmClient(),
      onSaved: async (resumeId) => {
        saved = resumeId;
        expect(await tdb.prisma.companyResume.count()).toBe(1);
        await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { runId: "other-run" } });
      },
    });
    expect(saved).toBeTruthy();
    expect(await tdb.prisma.companyResume.count()).toBe(0);
    const after = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ status: "running", runId: "other-run", resumeId: null });
    expect(await tdb.prisma.notification.count({ where: { userId: "ua" } })).toBe(0);
  });

  it("저장한 뒤 완료 기록이 실패하면 만든 이력서를 지우고 실패로 기록한다(다시 시도해도 중복이 생기지 않게)", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", {
      createClient: () => new FakeLlmClient(),
      onSaved: async () => {
        throw new Error("db down");
      },
    });
    expect(await tdb.prisma.companyResume.count()).toBe(0);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
    expect(await tdb.prisma.notification.count({ where: { userId: "ua", kind: "resume-draft-failed" } })).toBe(1);
  });

  it("멈춘 작업은 알림 폴링만으로도 실패로 닫히고 실패 알림이 한 번 온다(진행 화면·목록을 열지 않아도)", async () => {
    const id = await startJob();
    state.afterTasks = [];
    await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { startedAt: new Date(Date.now() - jobs.draftStaleMs() - 1000) } });
    const poll = async () =>
      (await (await notificationsRoute.GET(new Request("http://localhost/api/notifications"))).json()) as {
        items: { kind: string; link: string }[];
        unreadCount: number;
      };
    const first = await poll();
    expect(first.items).toEqual([expect.objectContaining({ kind: "resume-draft-failed", link: `/app/resumes/drafts/${id}` })]);
    expect(first.unreadCount).toBe(1);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
    // 다시 폴링해도 또 만들지 않는다.
    expect((await poll()).unreadCount).toBe(1);
  });

  it("동시에 온 시작 요청도 동시 작업 상한을 넘지 않는다", async () => {
    const results = await Promise.all(Array.from({ length: jobs.MAX_ACTIVE_DRAFT_JOBS + 2 }, () => post(draftBody())));
    expect(results.filter((r) => r.status === 202)).toHaveLength(jobs.MAX_ACTIVE_DRAFT_JOBS);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(jobs.MAX_ACTIVE_DRAFT_JOBS);
  });

  it("빈 문서 생성도 진행 중인 초안을 이력서 수에 센다", async () => {
    await startJob();
    state.afterTasks = [];
    const { MAX_RESUMES_PER_USER } = await import("./types");
    await tdb.prisma.companyResume.createMany({
      data: Array.from({ length: MAX_RESUMES_PER_USER - 1 }, (_, i) => ({ id: `r${i}`, userId: "ua", templateId: "developer", title: `r${i}` })),
    });
    expect((await post(draftBody({ source: { kind: "blank" } }))).status).toBe(409);
    expect(await tdb.prisma.companyResume.count()).toBe(MAX_RESUMES_PER_USER - 1);
  });

  it("다시 시도로 runId가 바뀌면 이전 실행은 이력서를 만들지 않는다", async () => {
    state.client = failingClient();
    const id = await startJob();
    const oldRun = (await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).runId;
    await runAfter();
    expect((await retry(id)).status).toBe(202);
    state.afterTasks = [];
    await jobs.runResumeDraftJob("ua", id, oldRun, "anthropic", { createClient: () => new FakeLlmClient() });
    expect(await tdb.prisma.companyResume.count()).toBe(0);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("running");
  });

  it("시간 상한에 걸리면 실패로 닫는다", async () => {
    const id = await startJob();
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    state.afterTasks = [];
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => new FakeLlmClient({ delayMs: 500 }), timeLimitMs: 20 });
    const after = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe("failed");
    expect(after.error).toContain("오래");
  });

  it("시간 상한은 작업 시작 시각부터 잰다(요청·자료 모으기에 쓴 시간을 뺀다)", async () => {
    const id = await startJob();
    state.afterTasks = [];
    await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { startedAt: new Date(Date.now() - 59_900) } });
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => new FakeLlmClient({ delayMs: 1_300 }), timeLimitMs: 60_000 });
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
  });

  it("목록에는 진행 중·실패한 작업만, 완료한 작업은 빠진다", async () => {
    const a = await startJob();
    await runAfter();
    const b = await startJob();
    const items = ((await (await listRoute.GET()).json()) as { items: { id: string }[] }).items.map((j) => j.id);
    expect(items).toEqual([b]);
    expect(items).not.toContain(a);
  });

  it("시간 상한: Vercel은 maxDuration - 30초, 그 밖은 15분", () => {
    expect(jobs.draftTimeLimitMs({ VERCEL: "1" })).toBe(270_000);
    expect(jobs.draftTimeLimitMs({})).toBe(15 * 60_000);
    expect(jobs.draftStaleMs({ VERCEL: "1" })).toBe(330_000);
    expect(resumesRoute.maxDuration).toBe(jobs.DRAFT_ROUTE_MAX_DURATION_SEC);
    expect(retryRoute.maxDuration).toBe(jobs.DRAFT_ROUTE_MAX_DURATION_SEC);
  });

  it("멈춤 판정: 워커가 선점한 작업(result.runner='worker')만 워커의 시간 상한(15분)을 기준으로 한다", () => {
    const vercel = { VERCEL: "1" };
    expect(jobs.draftStaleMs(vercel)).toBe(330_000);
    expect(jobs.workerDraftStaleMs(vercel)).toBe(15 * 60_000 + 60_000);
    expect(jobs.draftStaleMsFor({ result: { runner: "worker" } }, vercel)).toBe(15 * 60_000 + 60_000);
    // 아직 아무도 선점하지 않았거나 Vercel이 맡은 작업(워커가 꺼져 fallback한 경우·CLI 엔진)은 Vercel 기준 그대로.
    expect(jobs.draftStaleMsFor({ result: null }, vercel)).toBe(330_000);
    expect(jobs.draftStaleMsFor({ result: { runner: "vercel", pendingVersionId: "v" } }, vercel)).toBe(330_000);
    expect(jobs.draftStaleMsFor({ result: ["worker"] }, vercel)).toBe(330_000);
  });

  it("멈춤 판정: 워커가 선점한 작업은 Vercel 기준(330초)을 넘겨도 닫지 않고, Vercel이 맡은 작업은 닫는다", async () => {
    const w = await startJob();
    const v = await startJob();
    state.afterTasks = [];
    // Vercel 기준(330초)과 워커 기준(16분)이 다르게 — VERCEL=1에서 확인한다.
    process.env.VERCEL = "1";
    try {
      const old = new Date(Date.now() - jobs.draftStaleMs() - 1000);
      await tdb.prisma.resumeDraftJob.update({ where: { id: w }, data: { startedAt: old, stage: "writing", result: { runner: "worker" } } });
      await tdb.prisma.resumeDraftJob.update({ where: { id: v }, data: { startedAt: old, stage: "writing", result: { runner: "vercel" } } });
      expect(await jobs.sweepStaleDraftJobs("ua")).toBe(1);
      expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: w } })).status).toBe("running");
      expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: v } })).status).toBe("failed");
      // 진행 중 작업 수에도 워커가 맡은 작업은 들어간다(330초가 지나도).
      expect((await (await listRoute.GET()).json()).items.map((j: { id: string; status: string }) => [j.id, j.status])).toContainEqual([w, "running"]);
      // 워커 기준도 넘기면 닫는다.
      await tdb.prisma.resumeDraftJob.update({ where: { id: w }, data: { startedAt: new Date(Date.now() - jobs.workerDraftStaleMs() - 1000) } });
      expect((await jobs.getDraftJob("ua", w))?.status).toBe("failed");
    } finally {
      delete process.env.VERCEL;
    }
  });

  it("선점하면 result에 실행 위치(runner='vercel')를 남긴다", async () => {
    const id = await startJob();
    await runAfter();
    // 완료 기록이 result를 메모로 다시 쓰므로, 선점 직후 값은 실패 경로로 확인한다.
    const id2 = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: id2 } });
    await jobs.runResumeDraftJob("ua", id2, row.runId, "anthropic", {
      createClient: () => {
        throw new Error("boom");
      },
    });
    const after = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: id2 } });
    expect(after.status).toBe("failed");
    expect(after.result).toMatchObject({ runner: "vercel" });
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
  });

  it("선점: 다른 실행(워커)이 이미 'writing'으로 선점했으면 실행하지 않는다", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { stage: "writing" } });
    const fake = new FakeLlmClient();
    const generate = vi.spyOn(fake, "generate");
    await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => fake });
    expect(generate).not.toHaveBeenCalled();
    expect(await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "running", stage: "writing" });
    expect(await tdb.prisma.companyResume.count()).toBe(0);
  });

  it("선점: 같은 runId로 동시에 두 번 시작해도 LLM·저장은 한 번만", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    const fake = new FakeLlmClient({ delayMs: 50 });
    const generate = vi.spyOn(fake, "generate");
    await Promise.all([0, 1].map(() => jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => fake })));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await tdb.prisma.companyResume.count()).toBe(1);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
    expect(await tdb.prisma.notification.count({ where: { userId: "ua", kind: "resume-draft-completed" } })).toBe(1);
  });

  it("선점 전 실패는 그사이 다른 실행이 선점했으면 실패로 덮지 않는다", async () => {
    const id = await startJob();
    state.afterTasks = [];
    const row = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } });
    // 자료를 읽는 동안 다른 실행이 선점하고, 이 실행의 자료 읽기는 실패한다(진단 재작성본이 사라짐).
    await tdb.prisma.diagnosisStage.deleteMany({ where: { diagnosisId: "d1" } });
    const findFirst = tdb.prisma.diagnosis.findFirst.bind(tdb.prisma.diagnosis);
    const spy = vi.spyOn(tdb.prisma.diagnosis, "findFirst").mockImplementation((async (args: never) => {
      await tdb.prisma.resumeDraftJob.update({ where: { id }, data: { stage: "writing" } });
      return findFirst(args);
    }) as never);
    try {
      await jobs.runResumeDraftJob("ua", id, row.runId, "anthropic", { createClient: () => new FakeLlmClient() });
    } finally {
      spy.mockRestore();
    }
    expect(await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "running", stage: "writing", error: null });
    expect(await tdb.prisma.notification.count({ where: { userId: "ua" } })).toBe(0);
  });

  it("작업 이름: 제목 > 공용 이력서 > 회사 · 직무", () => {
    expect(jobs.draftJobLabel({ kind: "company", company: "토스", roleTitle: "백엔드", title: "" })).toBe("토스 · 백엔드");
    expect(jobs.draftJobLabel({ kind: "general", company: "", roleTitle: "", title: "" })).toBe("공용 이력서");
    expect(jobs.draftJobLabel({ kind: "company", company: "토스", roleTitle: "백엔드", title: "내 이력서" })).toBe("내 이력서");
  });
});
