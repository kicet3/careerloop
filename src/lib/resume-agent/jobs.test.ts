/**
 * 그래프 이력서 에이전트 통합(PGlite + 로컬 저장소 + 가짜 LLM + 메모리 그래프 저장소, 세션은 가짜).
 * POST /api/resumes(mode agent) → 202 → after()로 이어 가기 → 단계별 저장 → 심사·수정 루프 → 이력서·리포트·알림.
 * 여러 호출에 나눠 실행, 동시 이어 가기(리스 하나), 실패 단계부터 다시 시도, 심사 실패 시 최선 초안 저장, 리스 만료 회수, 24시간 멈춤,
 * 그래프 부족, 동시 작업 3개·이력서 상한, 루프 종료(passed·plateau·max_rounds), "JD 요건 반영" 고정(§0.1).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import type { LlmClient, LlmRequest } from "@/lib/llm";
import { createTestDb, type TestDb } from "@/test/db";
import { AGENT_JD, graphA } from "./__fixtures__/agent-graph";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-agent-jobs-")), "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "홍길동", role: "user" } as { id: string; email: string; name: string | null } | null,
  afterTasks: [] as (() => unknown)[],
  client: null as unknown,
  graphs: new Map<string, unknown>(),
  calls: [] as { label: string; user: string }[],
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
vi.mock("@/lib/llm", async (orig) => ({ ...(await orig<typeof import("@/lib/llm")>()), createLlmClient: () => state.client }));
vi.mock("@/lib/graph/service", async () => {
  const { markGraphOwner } = await import("@/lib/graph/owner");
  const text = await import("@/lib/graph/text");
  return {
    graphToText: text.graphToText,
    graphEnabled: () => true,
    getCareerGraph: async (userId: string): Promise<CareerGraph> => {
      const g = (state.graphs.get(userId) as CareerGraph | undefined) ?? { person: { id: "me", name: null }, nodes: [], edges: [] };
      return markGraphOwner(structuredClone(g), userId);
    },
  };
});

let tdb: TestDb;
let jobs: typeof import("./jobs");
let resumesRoute: typeof import("@/app/api/resumes/route");
let jobRoute: typeof import("@/app/api/resumes/agent-jobs/[id]/route");
let retryRoute: typeof import("@/app/api/resumes/agent-jobs/[id]/retry/route");
let FakeLlmClient: typeof import("@/test/fake-llm").FakeLlmClient;
let LlmPermanentError: typeof import("@/lib/llm").LlmPermanentError;
let layout: typeof import("@/lib/resumes/layout");
let service: typeof import("@/lib/resumes/service");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL", "RESUME_AGENT", "RESUME_AGENT_CHAIN_SECRET", "RESUME_AGENT_MAX_REVISIONS"]) delete process.env[k];
  // 이 파일은 v1 단계 계획(전체 작성·패치 수정)을 시험한다 — v2(구역별 에이전트)는 jobs-v2.test.ts.
  process.env.RESUME_AGENT_PIPELINE = "1";
  tdb = await createTestDb();
  jobs = await import("./jobs");
  resumesRoute = await import("@/app/api/resumes/route");
  jobRoute = await import("@/app/api/resumes/agent-jobs/[id]/route");
  retryRoute = await import("@/app/api/resumes/agent-jobs/[id]/retry/route");
  ({ FakeLlmClient } = await import("@/test/fake-llm"));
  ({ LlmPermanentError } = await import("@/lib/llm"));
  layout = await import("@/lib/resumes/layout");
  service = await import("@/lib/resumes/service");
});
afterAll(() => {
  delete process.env.RESUME_AGENT_PIPELINE;
  return tdb.close();
});

/** 가짜 LLM을 감싸 호출(단계·task와 user 프롬프트)을 기록한다. fail이 true를 돌려주면 그 호출을 실패시킨다. */
function recordingClient(fail?: (req: LlmRequest<unknown>) => Error | null, delayMs = 0): LlmClient {
  const fake = new FakeLlmClient({ delayMs });
  return {
    name: "rec",
    generate: async (req) => {
      const label = req.task ?? req.stage;
      state.calls.push({ label, user: req.user });
      const err = fail?.(req as LlmRequest<unknown>);
      if (err) throw err;
      return fake.generate(req);
    },
  };
}

beforeEach(async () => {
  await tdb.reset();
  delete process.env.RESUME_AGENT_MAX_REVISIONS;
  state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
  state.afterTasks = [];
  state.calls = [];
  state.client = recordingClient();
  state.graphs = new Map([["ua", graphA()]]);
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: id === "ua" ? "홍길동" : null, status: "approved" } });
});

const body = (extra: Record<string, unknown> = {}) => ({
  company: "토스",
  roleTitle: "백엔드 개발자",
  jdText: AGENT_JD,
  templateId: "developer",
  source: { kind: "graph" },
  ...extra,
});
const post = (b: unknown) =>
  resumesRoute.POST(new Request("http://localhost/api/resumes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function runAfter() {
  while (state.afterTasks.length) await state.afterTasks.shift()!();
}
async function start(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post(body(extra));
  expect(res.status).toBe(202);
  const json = (await res.json()) as { agentJob?: { id: string } };
  expect(json.agentJob).toBeTruthy();
  return json.agentJob!.id;
}
async function view(id: string) {
  return ((await (await jobRoute.GET(new Request(`http://localhost/x`), ctx(id))).json()) as { agentJob: import("./job-types").ResumeAgentJobView }).agentJob;
}
const countCalls = (label: string) => state.calls.filter((c) => c.label === label).length;

describe("에이전트 작업 — 끝까지", () => {
  it("JD 분석 → 근거 검색 → 전략 → 초안(사실 검증) → 심사 → 수정 → 재심사 통과 → 최종 7명 → 저장·리포트·알림", async () => {
    const id = await start();
    expect(state.afterTasks).toHaveLength(1);
    await runAfter();

    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(job.resumeId).toBeTruthy();
    expect(job.stopReason).toBe("passed");
    // 라운드 점수: 첫 초안은 ATS 탈락(Redis·AWS 누락), 수정 뒤 통과.
    expect(job.rounds.map((r) => r.atsPass)).toEqual([false, true]);
    expect(job.rounds[1]!.passCount).toBeGreaterThanOrEqual(2);
    expect(job.rounds[1]!.matchScore).toBeGreaterThan(job.rounds[0]!.matchScore);
    expect(job.finalPanel?.total).toBe(7);
    expect(job.coverage?.mustTotal).toBe(3);
    expect(job.steps.find((s) => s.key === "r1.revise")?.status).toBe("done");

    // 호출 수: jd 1, plan 1, write 2, review 4×2, revise 1, 최종 독자 4.
    expect(countCalls("jd")).toBe(1);
    expect(countCalls("resume-agent-plan")).toBe(1);
    expect(countCalls("resume-agent-write")).toBe(2);
    expect(countCalls("resume-agent-revise")).toBe(1);
    expect(countCalls("ats")).toBe(2);
    expect(countCalls("fit")).toBe(2);
    for (const r of ["rival", "ceo", "recruiter", "teammate"]) expect(countCalls(r)).toBe(1);

    const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
    expect(row.input).toBeNull();
    const report = (await jobs.getAgentReportForResume("ua", job.resumeId!))!.report;
    expect(report.stopReason).toBe("passed");
    expect(report.finalPanel?.verdicts).toHaveLength(7);
    expect(report.rounds[1]!.changes.length).toBeGreaterThan(0);
    expect(report.rounds[1]!.changes[0]!.reviewers).toContain("ats");

    const detail = await service.getResumeDetail("ua", job.resumeId!);
    const doc = detail!.current!.document;
    const text = layout.resumeToText(doc, "developer");
    expect(doc.basics.name).toBe("홍길동");
    expect(doc.basics.email).toBe("ua@x.com");
    expect(text).toContain("Redis");
    // 사실 검증: 근거에 없는 수치(99%)는 [ADD: 수치 확인]으로 바뀐다.
    expect(text).toContain("[ADD: 수치 확인 — 장애 대응 시간을 99% 줄였다]");
    expect(report.factCheck.numbersFlagged).toBeGreaterThan(0);
    expect(detail!.versions[0]!.source).toBe("ai");
    // 인용(내부 필드)은 저장된 문서에 없다.
    expect(JSON.stringify(doc)).not.toContain("citations");

    const notes = await tdb.prisma.notification.findMany({ where: { userId: "ua" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "resume-agent-completed", link: `/app/resumes/${job.resumeId}?report=1` });
  });

  it("JD 요건 반영 고정(§0.1): 모든 요건이 리포트에 정확히 한 번, 충족·부분 요건의 이력서 줄은 최종 문서에 실제로 있다", async () => {
    const id = await start({ jdText: `${AGENT_JD}\n- Terraform 인프라 자동화 경험` });
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("completed");
    const report = (await jobs.getAgentReportForResume("ua", job.resumeId!))!.report;
    const jdRow = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.jd" } });
    const jd = (jdRow.output as { jd: { mustHave: { id: string }[]; niceToHave: { id: string }[] } }).jd;
    const ids = [...jd.mustHave, ...jd.niceToHave].map((r) => r.id);
    expect(report.requirements.map((r) => r.requirementId).sort()).toEqual([...ids].sort());
    for (const m of jd.mustHave) expect(report.requirements.filter((r) => r.requirementId === m.id)).toHaveLength(1);
    const doc = (await service.getResumeDetail("ua", job.resumeId!))!.current!.document;
    const text = layout.resumeToText(doc, "developer");
    for (const r of report.requirements) {
      if (r.status === "met" || r.status === "partial") {
        expect(r.resumeLine, r.requirementId).toBeTruthy();
        expect(text).toContain(r.resumeLine!.trim());
      }
    }
    // 근거가 없는 요건(Terraform)은 지어내지 않고 질문으로 남는다.
    expect(text).not.toContain("Terraform");
    expect(report.gaps.some((g) => /Terraform/.test(g.question) || /Terraform/.test(g.chatPrompt))).toBe(true);
    expect(report.requirements.every((r) => r.evidence.every((e) => !("nodeId" in e)))).toBe(true);
  });
});

describe("프로젝트 근거 칸(evidence)", () => {
  it("모델이 프로젝트 evidence를 채워도 저장한 이력서에서는 비우고, 미리보기 텍스트에 '근거'가 없다", async () => {
    const fake = new FakeLlmClient({ delayMs: 0 });
    let filled = 0;
    state.client = {
      name: "rec",
      generate: async (req) => {
        state.calls.push({ label: req.task ?? req.stage, user: req.user });
        const res = await fake.generate(req);
        if (req.task === "resume-agent-write") {
          const o = res.output as { projects?: { evidence: string }[]; document?: { projects?: { evidence: string }[] } };
          for (const p of o.projects ?? o.document?.projects ?? []) {
            p.evidence = "정산 대시보드 근거자료";
            filled++;
          }
        }
        return res;
      },
    } as LlmClient;
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(filled).toBeGreaterThan(0);
    const doc = (await service.getResumeDetail("ua", job.resumeId!))!.current!.document;
    expect(doc.projects.length).toBeGreaterThan(0);
    expect(doc.projects.every((p) => p.evidence === "")).toBe(true);
    expect(layout.resumeToText(doc, "developer")).not.toContain("근거자료");
  });
});

describe("수정 루프 종료", () => {
  it("근거로 못 고치는 키워드만 남으면 다음 수정이 op 0개 → 심사 없이 plateau로 끝난다", async () => {
    const id = await start({ jdText: `${AGENT_JD}\n- Terraform 인프라 자동화 경험` });
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(job.stopReason).toBe("plateau");
    expect(job.rounds).toHaveLength(2);
    expect(countCalls("resume-agent-revise")).toBe(2);
    expect(countCalls("ats")).toBe(2); // 두 번째 수정은 noop이라 세 번째 심사는 없다
    const steps = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } });
    expect(steps.find((s) => s.key === "r2.review")).toBeUndefined();
  });

  it("RESUME_AGENT_MAX_REVISIONS=0이면 첫 심사 뒤 max_rounds로 끝난다(수정 없음)", async () => {
    process.env.RESUME_AGENT_MAX_REVISIONS = "0";
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(job.stopReason).toBe("max_rounds");
    expect(countCalls("resume-agent-revise")).toBe(0);
    expect(job.rounds).toHaveLength(1);
  });
});

describe("여러 호출에 걸친 실행", () => {
  it("한 호출에 한 단계씩 끊어도 같은 결과: waiting → 연쇄 요청 → 이어 가기, 단계 출력은 하나씩", async () => {
    const res = await post(body());
    const id = ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
    state.afterTasks = []; // 라우트 예약은 버리고 직접 나눠 실행한다
    const chain = vi.fn(async (job: { id: string; runId: string }) => (void job, { ok: true as const }));
    let calls = 0;
    for (; calls < 30; calls++) {
      await jobs.advanceAgentJob(id, { deps: { maxStepsPerCall: 1, chain } });
      const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
      if (row.status === "completed") break;
      expect(row.status).toBe("waiting");
      expect(row.leaseId).toBeNull();
    }
    const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("completed");
    expect(row.continuations).toBe(calls + 1);
    expect(chain).toHaveBeenCalledTimes(calls);
    expect(chain.mock.calls[0]![0]).toEqual({ id, runId: row.runId });
    const keys = (await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } })).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(countCalls("jd")).toBe(1);
  });

  it("동시에 이어 가기 2개 → 리스 하나만: 같은 단계를 두 번 부르지 않는다", async () => {
    state.client = recordingClient(undefined, 30);
    const res = await post(body());
    const id = ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
    state.afterTasks = [];
    await Promise.all([jobs.advanceAgentJob(id, { deps: { maxStepsPerCall: 1 } }), jobs.advanceAgentJob(id, { deps: { maxStepsPerCall: 1 } })]);
    expect(countCalls("jd")).toBe(1);
    const steps = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } });
    expect(steps.map((s) => s.key)).toEqual(["r0.jd"]);
  });

  it("리스 만료(함수 강제 종료 흉내) → 조회가 waiting으로 회수하고 needsKick → 다른 호출이 같은 단계를 다시 실행, 결과 하나", async () => {
    const res = await post(body());
    const id = ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
    state.afterTasks = [];
    // 단계를 시작한 직후 "죽은" 것처럼: 단계 행은 running, 리스는 지난 시각.
    await jobs.advanceAgentJob(id, {
      deps: {
        onStepStart: async () => {
          throw new Error("killed");
        },
      },
    });
    await tdb.prisma.resumeAgentJob.update({ where: { id }, data: { status: "running", leaseId: "dead", leaseExpiresAt: new Date(Date.now() - 1000) } });
    const v = await view(id);
    expect(v.status).toBe("waiting");
    expect(v.needsKick).toBe(true);
    await jobs.advanceAgentJob(id, { deps: { maxStepsPerCall: 1 } });
    const jd = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.jd" } });
    expect(jd.status).toBe("done");
    expect(jd.attempt).toBe(2);
  });

  it("waiting으로 23시간은 그대로, 24시간이 넘으면 실패로 닫고 알림 1개", async () => {
    const res = await post(body());
    const id = ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
    state.afterTasks = [];
    await tdb.prisma.resumeAgentJob.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 23 * 3600_000) } });
    expect((await view(id)).status).toBe("waiting");
    await tdb.prisma.resumeAgentJob.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 25 * 3600_000) } });
    const v = await view(id);
    expect(v.status).toBe("failed");
    expect(v.canRetry).toBe(true);
    await view(id);
    const notes = await tdb.prisma.notification.findMany({ where: { userId: "ua" } });
    expect(notes.map((n) => n.kind)).toEqual(["resume-agent-failed"]);
  });
});

describe("중단·시간 상한·연쇄 복구", () => {
  async function startDetached(): Promise<string> {
    const res = await post(body());
    const id = ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
    state.afterTasks = [];
    return id;
  }
  async function runUntil(id: string, key: string) {
    for (let i = 0; i < 30; i++) {
      const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
      const steps = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } });
      if (row.status !== "waiting" && row.status !== "running") return;
      const { evaluateRun } = await import("./next-step");
      if (evaluateRun(steps, { maxRevisions: 2, panel: "core" }).next?.key === key) return;
      await jobs.advanceAgentJob(id, { deps: { maxStepsPerCall: 1, chain: async () => ({ ok: true as const }) } });
    }
  }
  const resumeCount = () => tdb.prisma.companyResume.count({ where: { userId: "ua" } });

  it("finalize: 완료 기록이 실패하면 만든 이력서를 지우고 다시 해서 이력서는 하나만", async () => {
    const id = await startDetached();
    let fails = 1;
    for (let i = 0; i < 30; i++) {
      await jobs.advanceAgentJob(id, {
        deps: {
          onResumeCreated: async () => {
            if (fails-- > 0) throw new Error("db blip");
          },
        },
      });
      if ((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).status === "completed") break;
    }
    const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("completed");
    expect(await resumeCount()).toBe(1);
    expect((await tdb.prisma.companyResume.findFirstOrThrow({ where: { userId: "ua" } })).id).toBe(row.resumeId);
    const fin = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "finalize" } });
    expect(fin.attempt).toBe(2);
  });

  it("finalize: 이력서를 만든 뒤 완료 기록 전에 함수가 죽어도(리스 만료) 다음 호출이 그 이력서를 회수해 하나만 남긴다", async () => {
    const id = await startDetached();
    await runUntil(id, "finalize");
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    let created = "";
    // 첫 호출: 이력서를 만든 직후 멈춘다(하트비트 없음 = 강제 종료와 같다).
    const zombie = jobs.advanceAgentJob(id, {
      deps: {
        heartbeatMs: 1e9,
        onResumeCreated: async (rid) => {
          created = rid;
          await hang;
        },
      },
    });
    for (let i = 0; i < 100 && !created; i++) await new Promise((r) => setTimeout(r, 10));
    expect(created).toBeTruthy();
    expect(await resumeCount()).toBe(1);
    await tdb.prisma.resumeAgentJob.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    await jobs.advanceAgentJob(id);
    const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("completed");
    expect(row.resumeId).not.toBe(created);
    expect(await resumeCount()).toBe(1);
    // 죽었던 호출이 깨어나도 소유를 잃었으니 완료하지 않고, 이력서도 늘지 않는다.
    release();
    await zombie;
    expect(await resumeCount()).toBe(1);
    expect((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).resumeId).toBe(row.resumeId);
  });

  it("중간에 끊긴(running으로 남은) 단계는 시도로 센다: 상한(3회)이면 실패로 닫고 잃은 토큰을 추정치로 더한다", async () => {
    const id = await startDetached();
    await tdb.prisma.resumeAgentStep.create({ data: { id: "st1", jobId: id, key: "r0.jd", kind: "jd", round: 0, status: "running", attempt: 3, startedAt: new Date() } });
    await jobs.advanceAgentJob(id);
    const job = await view(id);
    expect(job.status).toBe("failed");
    expect(job.failedStep).toBe("r0.jd");
    expect(countCalls("jd")).toBe(0);
    const step = await tdb.prisma.resumeAgentStep.findUniqueOrThrow({ where: { id: "st1" } });
    expect(step.status).toBe("failed");
    expect((step.usage as { inputTokens: number }).inputTokens).toBe(15_000);
  });

  it("호출 마감 때문에 줄어든 상한에서 시간이 다 되면 시도로 세지 않고 대기 + 연쇄, 온전한 상한의 시간 초과는 센다", async () => {
    const id = await startDetached();
    const hang: LlmClient = {
      name: "hang",
      generate: (req) =>
        new Promise((_, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal!.reason));
        }),
    };
    state.client = hang;
    const chain = vi.fn(async () => ({ ok: true as const }));
    const now = Date.now();
    await jobs.advanceAgentJob(id, { deadlineAt: now + 40_000, deps: { chain, timeoutSignal: () => AbortSignal.timeout(5) } });
    let step = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.jd" } });
    expect(step.status).toBe("pending");
    expect(step.attempt).toBe(0);
    expect(chain).toHaveBeenCalledTimes(1);
    expect((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).status).toBe("waiting");

    await jobs.advanceAgentJob(id, { deadlineAt: Date.now() + 10 * 60_000, deps: { chain, maxStepsPerCall: 1, timeoutSignal: () => AbortSignal.timeout(5) } });
    step = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.jd" } });
    expect(step.attempt).toBe(1);
  });

  it("시간 부족이 아닌 이유(예상 못 한 오류)로 멈춰도 내 리스를 놓았으면 다음 호출을 연다", async () => {
    const id = await startDetached();
    const chain = vi.fn(async () => ({ ok: true as const }));
    await jobs.advanceAgentJob(id, {
      deps: {
        chain,
        chainDelayMs: 0,
        onStepStart: async () => {
          throw new Error("db blip");
        },
      },
    });
    expect(chain).toHaveBeenCalledTimes(1);
    expect((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).status).toBe("waiting");
  });
});

describe("실패·다시 시도·대체 경로", () => {
  it("plan이 영구 오류로 실패 → 작업 실패(실패 단계 기록) → 다시 시도는 끝난 jd·retrieve를 건너뛰고 plan부터", async () => {
    let failPlan = true;
    state.client = recordingClient((req) => (failPlan && req.task === "resume-agent-plan" ? new LlmPermanentError("거절", "refusal") : null));
    const id = await start();
    await runAfter();
    const failed = await view(id);
    expect(failed.status).toBe("failed");
    expect(failed.failedStep).toBe("r0.plan");
    expect(failed.canRetry).toBe(true);
    expect(failed.canFallback).toBe(true);
    expect((await tdb.prisma.notification.findMany()).map((n) => n.kind)).toEqual(["resume-agent-failed"]);

    failPlan = false;
    state.calls = [];
    const res = await retryRoute.POST(new Request(`http://localhost/x/retry`, { method: "POST" }), ctx(id));
    expect(res.status).toBe(202);
    await runAfter();
    expect((await view(id)).status).toBe("completed");
    expect(countCalls("jd")).toBe(0);
    expect(countCalls("resume-agent-plan")).toBe(1);
  });

  it("?mode=single: 같은 입력으로 빠른 초안 작업을 만들고 에이전트 작업은 취소로 닫는다", async () => {
    state.client = recordingClient((req) => (req.task === "resume-agent-plan" ? new LlmPermanentError("거절", "refusal") : null));
    const id = await start();
    await runAfter();
    state.client = recordingClient();
    const res = await retryRoute.POST(new Request(`http://localhost/x/retry?mode=single`, { method: "POST" }), ctx(id));
    expect(res.status).toBe(202);
    const { draftJob } = (await res.json()) as { draftJob: { id: string } };
    expect(draftJob.id).toBeTruthy();
    expect((await view(id)).status).toBe("canceled");
    await runAfter();
    const draft = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: draftJob.id } });
    expect(draft.status).toBe("completed");
  });

  it("심사(ats)가 계속 실패하면 3회 시도 뒤 가장 좋은 검증 초안을 저장하고 review_failed로 완료", async () => {
    state.client = recordingClient((req) => (req.stage === "ats" ? new Error("boom") : null));
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(job.stopReason).toBe("review_failed");
    expect(job.resumeId).toBeTruthy();
    const report = (await jobs.getAgentReportForResume("ua", job.resumeId!))!.report;
    expect(report.stopReason).toBe("review_failed");
    expect(report.finalPanel).toBeNull();
    // 단계 안 1회 재요청 × 시도 3회 = 6, 성공한 심사(gatekeeper 등)는 partial로 남아 다시 부르지 않는다.
    expect(countCalls("ats")).toBe(6);
    expect(countCalls("gatekeeper")).toBe(1);
  });

  it("그래프에 쓸 경력이 없으면 LLM 비용을 더 쓰기 전에 insufficient_graph로 멈춘다(다시 시도 불가, 빠른 초안 가능)", async () => {
    state.graphs.set("ua", { person: { id: "me", name: null }, nodes: [{ id: "s1", label: "Skill", props: { name: "Excel" }, createdAt: 1, updatedAt: 1 }], edges: [] });
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("failed");
    expect(job.errorCode).toBe("insufficient_graph");
    expect(job.canRetry).toBe(false);
    expect(job.canFallback).toBe(true);
    expect(countCalls("resume-agent-plan")).toBe(0);
  });
});

describe("한도", () => {
  it("동시 진행 3개까지: 상한을 채운 뒤의 시작은 409 + 진행 중인 작업 id", async () => {
    const ids: string[] = [];
    for (let i = 0; i < jobs.MAX_ACTIVE_AGENT_JOBS; i++) ids.push(await start());
    expect(jobs.MAX_ACTIVE_AGENT_JOBS).toBe(3);
    const res = await post(body());
    expect(res.status).toBe(409);
    const data = (await res.json()) as { code: string; agentJobId: string; error: string };
    expect(data.code).toBe("busy");
    expect(ids).toContain(data.agentJobId);
    expect(data.error).toMatch(/동시에 3개/);
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(jobs.MAX_ACTIVE_AGENT_JOBS);
    // 하나가 끝나면 다시 시작할 수 있다.
    await tdb.prisma.resumeAgentJob.update({ where: { id: ids[0]! }, data: { status: "canceled" } });
    expect((await post(body())).status).toBe(202);
  });

  it("동시에 온 시작 요청도 동시 작업 상한을 넘지 않는다", async () => {
    const results = await Promise.all(Array.from({ length: jobs.MAX_ACTIVE_AGENT_JOBS + 2 }, () => post(body())));
    expect(results.filter((r) => r.status === 202)).toHaveLength(jobs.MAX_ACTIVE_AGENT_JOBS);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(jobs.MAX_ACTIVE_AGENT_JOBS);
  });

  it("하루 한도 없음: 여러 번 시작해도 429가 아니다", async () => {
    for (let i = 0; i < 8; i++) {
      await start();
      await tdb.prisma.resumeAgentJob.updateMany({ data: { status: "canceled" } });
    }
    expect((await post(body())).status).toBe(202);
    expect(await tdb.prisma.rateEvent.count({ where: { bucket: "resume-agent" } })).toBe(0);
  });

  it("이력서 수 상한은 진행 중(waiting 포함) 에이전트 작업도 센다", async () => {
    const { MAX_RESUMES_PER_USER } = await import("@/lib/resumes/types");
    await start();
    const { assertResumeSlots } = await import("@/lib/resumes/draft-jobs");
    for (let i = 0; i < MAX_RESUMES_PER_USER - 1; i++) {
      await tdb.prisma.companyResume.create({ data: { id: `cr${i}`, userId: "ua", company: "c", roleTitle: "r", templateId: "developer", title: "t" } });
    }
    await expect(assertResumeSlots("ua")).rejects.toThrow(/까지 만들 수 있습니다/);
  });

  it("mode=single이면 에이전트 대신 빠른 초안 작업(202 draftJob)", async () => {
    const res = await post(body({ mode: "single" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toHaveProperty("draftJob");
  });

  it("경험 그래프가 비어 있으면 에이전트를 시작하지 않고(JD 비용 안 씀) 빠른 초안 + modeFallback", async () => {
    state.graphs.set("ua", { person: { id: "me", name: null }, nodes: [], edges: [] });
    expect(await jobs.agentAvailableFor({ id: "ua", email: "ua@x.com" })).toBe(false);
    const res = await post(body({ mode: "agent" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ modeFallback: "agent_unavailable" });
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(0);
    expect(countCalls("jd")).toBe(0);
    state.graphs.set("ua", graphA());
    expect(await jobs.agentAvailableFor({ id: "ua", email: "ua@x.com" })).toBe(true);
  });

  it("RESUME_AGENT=0이면 mode=agent 요청도 빠른 초안으로 만들고 modeFallback을 알린다", async () => {
    process.env.RESUME_AGENT = "0";
    try {
      const res = await post(body({ mode: "agent" }));
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ modeFallback: "agent_unavailable" });
    } finally {
      delete process.env.RESUME_AGENT;
    }
  });

  it("이력서 목록 띠(listVisibleDraftJobs)는 에이전트 작업도 진행 화면 링크와 함께 돌려준다", async () => {
    const id = await start();
    const { listVisibleDraftJobs } = await import("@/lib/resumes/draft-jobs");
    const list = await listVisibleDraftJobs("ua");
    expect(list.find((j) => j.id === id)).toMatchObject({ mode: "agent", href: `/app/resumes/agent/${id}`, status: "running" });
  });
});

describe("동시 작업 이어 가기", () => {
  it("agentJobsNeedingKick: 대기 중이고 리스가 없는 내 작업·리스가 만료된 작업만(exceptId 제외, 남의 작업 제외)", async () => {
    const t = Date.now();
    const row = (id: string, userId: string, extra: Record<string, unknown>) =>
      tdb.prisma.resumeAgentJob.create({ data: { id, userId, runId: "r", label: "x", input: {}, status: "waiting", updatedAt: new Date(t - 10 * 60_000), ...extra } });
    await row("k-wait", "ua", {});
    await row("k-self", "ua", {});
    await row("k-leased", "ua", { status: "running", leaseId: "l", leaseExpiresAt: new Date(t + 60_000) });
    await row("k-lost", "ua", { status: "running", leaseId: "l", leaseExpiresAt: new Date(t - 60_000) });
    await row("k-done", "ua", { status: "completed" });
    await row("k-other", "ub", {});
    expect((await jobs.agentJobsNeedingKick("ua", { exceptId: "k-self", now: t })).sort()).toEqual(["k-lost", "k-wait"]);
  });
});

describe("실행기(맥미니)", () => {
  const SECRET = "s".repeat(40);
  it("handOffToRunner: 실행기 주소·비밀이 있고 202를 받으면 true, 없거나 실패하면 false(여기서 실행)", async () => {
    const http = await import("./http");
    const id = await start();
    const { runId } = (await tdb.prisma.resumeAgentJob.findFirst({ where: { id } }))!;
    const env = { RESUME_AGENT_CHAIN_SECRET: SECRET, RESUME_AGENT_RUNNER_URL: "https://agent.example.com" };
    const calls: { id: string; runId: string }[] = [];
    const ok = async (j: { id: string; runId: string }) => (calls.push(j), { ok: true as const });
    expect(await http.handOffToRunner(id, { userId: "ua" }, { env, chain: ok })).toBe(true);
    expect(calls).toEqual([{ id, runId }]);
    expect(await http.handOffToRunner(id, { userId: "ub" }, { env, chain: ok })).toBe(false);
    expect(await http.handOffToRunner(id, { runId }, { env, chain: async () => ({ ok: false, error: "status_502" }) })).toBe(false);
    expect((await tdb.prisma.resumeAgentJob.findFirst({ where: { id } }))!.chainError).toBe("handoff:status_502");
    expect(await http.handOffToRunner(id, { runId }, { env: { RESUME_AGENT_CHAIN_SECRET: SECRET }, chain: ok })).toBe(false);
    expect(await http.handOffToRunner(id, { runId }, { env: { ...env, RESUME_AGENT_RUNNER: "1" }, chain: ok })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("sweepRunnerJobs: 이어 줄 호출이 없는 작업(대기 + 리스 없음, 리스 만료)만 전 사용자에서 주워 실행하고 동시 실행 수를 넘지 않는다", async () => {
    const t = Date.now();
    const row = (id: string, userId: string, extra: Record<string, unknown>) =>
      tdb.prisma.resumeAgentJob.create({ data: { id, userId, runId: `run-${id}`, label: "x", input: {}, status: "waiting", updatedAt: new Date(t - 60_000), ...extra } });
    await row("s-wait", "ua", { updatedAt: new Date(t - 90_000) });
    await row("s-other", "ub", { updatedAt: new Date(t - 80_000) });
    await row("s-lost", "ua", { status: "running", leaseId: "l", leaseExpiresAt: new Date(t - 1_000), updatedAt: new Date(t - 70_000) });
    await row("s-fresh", "ua", { updatedAt: new Date(t - 1_000) });
    await row("s-leased", "ua", { status: "running", leaseId: "l", leaseExpiresAt: new Date(t + 60_000) });
    await row("s-done", "ua", { status: "completed" });
    // 이 빌드보다 새 버전의 작업은 집지 않는다(실행기를 다시 빌드하기 전에는 Vercel이 실행한다).
    await row("s-newer", "ua", { schemaVersion: 9999, updatedAt: new Date(t - 95_000) });
    const started: string[] = [];
    const release: (() => void)[] = [];
    const advance = (jobId: string, o: { runId: string; deadlineAt: number }) => {
      expect(o.runId).toBe(`run-${jobId}`);
      expect(o.deadlineAt).toBe(t + jobs.SELF_HOSTED_AGENT_TIME_LIMIT_MS);
      started.push(jobId);
      return new Promise<void>((r) => release.push(r));
    };
    expect(await jobs.sweepRunnerJobs({ now: t, concurrency: 2, advance })).toBe(2);
    expect(started).toEqual(["s-wait", "s-other"]);
    // 자리가 찼으면 더 시작하지 않고, 실행 중인 작업을 다시 집지 않는다.
    expect(await jobs.sweepRunnerJobs({ now: t, concurrency: 2, advance })).toBe(0);
    expect(await jobs.sweepRunnerJobs({ now: t, concurrency: 3, advance })).toBe(1);
    expect(started).toEqual(["s-wait", "s-other", "s-lost"]);
    release.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 0));
    await tdb.prisma.resumeAgentJob.updateMany({ where: { id: { in: started } }, data: { status: "completed" } });
    // 실행기는 더 새 버전의 작업을 실패로 닫지 않고 그대로 둔다.
    vi.stubEnv("RESUME_AGENT_RUNNER", "1");
    vi.stubEnv("VERCEL", "");
    await jobs.advanceAgentJob("s-newer");
    vi.unstubAllEnvs();
    expect((await tdb.prisma.resumeAgentJob.findFirst({ where: { id: "s-newer" } }))!.status).toBe("waiting");
    expect(await jobs.sweepRunnerJobs({ now: t, concurrency: 3, advance })).toBe(0);
  });
});
