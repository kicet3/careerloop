/**
 * 구역별 에이전트(파이프라인 v2) 통합(PGlite + 로컬 저장소 + 가짜 LLM + 메모리 그래프 저장소, 세션은 가짜).
 * POST /api/resumes(mode agent) → jd(저장된 분석 재사용) → retrieve → brief → 웨이브 1·2(병렬) → compose → review → critique → 지시받은 구역만
 * 다시 쓰기 → compose → review → final_panel → finalize(지원 동기 초안·추천 저장). 시간 예산 배치 분할, 리스 상실, 구역 실패 대체, 버전 고정.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import type { LlmClient, LlmRequest } from "@/lib/llm";
import { createTestDb, type TestDb } from "@/test/db";
import { AGENT_JD, B_MARK, graphA, graphB } from "./__fixtures__/agent-graph";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-agent-v2-")), "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "홍길동", role: "user" } as { id: string; email: string; name: string | null } | null,
  afterTasks: [] as (() => unknown)[],
  client: null as unknown,
  graphs: new Map<string, unknown>(),
  calls: [] as { label: string; user: string; section: string | null }[],
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
let suggestRoute: typeof import("@/app/api/resumes/[id]/motivation/suggest/route");
let FakeLlmClient: typeof import("@/test/fake-llm").FakeLlmClient;
let LlmPermanentError: typeof import("@/lib/llm").LlmPermanentError;
let service: typeof import("@/lib/resumes/service");
let layout: typeof import("@/lib/resumes/layout");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL", "RESUME_AGENT", "RESUME_AGENT_CHAIN_SECRET", "RESUME_AGENT_MAX_REVISIONS", "RESUME_AGENT_PIPELINE", "RESUME_AGENT_PARALLEL", "RESUME_AGENT_MOTIVATION"]) delete process.env[k];
  tdb = await createTestDb();
  jobs = await import("./jobs");
  resumesRoute = await import("@/app/api/resumes/route");
  jobRoute = await import("@/app/api/resumes/agent-jobs/[id]/route");
  retryRoute = await import("@/app/api/resumes/agent-jobs/[id]/retry/route");
  suggestRoute = await import("@/app/api/resumes/[id]/motivation/suggest/route");
  ({ FakeLlmClient } = await import("@/test/fake-llm"));
  ({ LlmPermanentError } = await import("@/lib/llm"));
  service = await import("@/lib/resumes/service");
  layout = await import("@/lib/resumes/layout");
});
afterAll(() => tdb.close());

const sectionOf = (user: string) => /^- 작성 구역: (\S+)$/m.exec(user)?.[1] ?? null;

function recordingClient(fail?: (req: LlmRequest<unknown>, section: string | null) => Error | null, delayMs = 0): LlmClient {
  const fake = new FakeLlmClient({ delayMs });
  return {
    name: "rec",
    generate: async (req) => {
      const label = req.task ?? req.stage;
      const section = sectionOf(req.user);
      state.calls.push({ label, user: `${req.system}\n${req.user}`, section });
      const err = fail?.(req as LlmRequest<unknown>, section);
      if (err) throw err;
      return fake.generate(req);
    },
  };
}

beforeEach(async () => {
  await tdb.reset();
  delete process.env.RESUME_AGENT_MAX_REVISIONS;
  delete process.env.RESUME_AGENT_PIPELINE;
  delete process.env.RESUME_AGENT_MOTIVATION;
  state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
  state.afterTasks = [];
  state.calls = [];
  state.client = recordingClient();
  state.graphs = new Map<string, unknown>([
    ["ua", graphA()],
    ["ub", graphB()],
  ]);
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: id === "ua" ? "홍길동" : "비밀B", status: "approved" } });
});

const body = (extra: Record<string, unknown> = {}) => ({ company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD, templateId: "developer", source: { kind: "graph" }, ...extra });
const post = (b: unknown) =>
  resumesRoute.POST(new Request("http://localhost/api/resumes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function runAfter() {
  while (state.afterTasks.length) await state.afterTasks.shift()!();
}
async function start(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await post(body(extra));
  expect(res.status).toBe(202);
  return ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
}
async function startDetached(extra: Record<string, unknown> = {}): Promise<string> {
  const id = await start(extra);
  state.afterTasks = [];
  return id;
}
async function view(id: string) {
  return ((await (await jobRoute.GET(new Request(`http://localhost/x`), ctx(id))).json()) as { agentJob: import("./job-types").ResumeAgentJobView }).agentJob;
}
const countCalls = (label: string, section?: string) => state.calls.filter((c) => c.label === label && (section === undefined || c.section === section)).length;
const stepKeys = async (id: string) => (await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id }, orderBy: { startedAt: "asc" } })).map((s) => s.key);

describe("v2 — 끝까지", () => {
  it("구역 에이전트 7개 + 총괄: 웨이브 순서, 지시받은 구역만 재작성, 통과, 지원 동기 초안·추천 저장, 리포트 v2", async () => {
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.pipelineVersion).toBe(2);
    expect(job.stopReason).toBe("passed");
    expect(job.rounds.map((r) => r.atsPass)).toEqual([false, true]);

    const keys = await stepKeys(id);
    for (const k of ["r0.jd", "r0.retrieve", "r0.brief", "r0.sec.experience", "r0.sec.projects", "r0.sec.extras", "r0.sec.motivation_suggest", "r0.sec.highlights", "r0.sec.skills", "r0.sec.motivation_draft", "r0.compose", "r0.review", "r0.critique", "r1.compose", "r1.review", "final_panel", "finalize"]) {
      expect(keys, k).toContain(k);
    }
    // 총괄이 지시한 구역만 라운드 1에 다시 쓴다(경력은 누락 키워드로 지시받는다, 핵심 성과·기타는 그대로).
    expect(keys).toContain("r1.sec.experience");
    expect(keys).not.toContain("r1.sec.extras");
    expect(keys).not.toContain("r1.sec.highlights");
    const crit = (await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.critique" } })).output as { feedback: { section: string }[] };
    // 라운드 1 본문이 바뀌어 지원 동기 초안도 새 본문(또는 총괄의 지원 동기 피드백)으로 다시 쓴다.
    expect(keys.filter((k) => k.startsWith("r1.sec.")).sort()).toEqual([...crit.feedback.map((f) => `r1.sec.${f.section}`), "r1.sec.motivation_draft"].sort());
    // 웨이브 2는 웨이브 1이 모두 끝난 뒤 시작한다.
    const rows = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } });
    const t = (k: string) => rows.find((r) => r.key === k)!;
    const wave1End = Math.max(...["experience", "projects", "extras", "motivation_suggest"].map((s) => t(`r0.sec.${s}`).finishedAt!.getTime()));
    for (const s of ["highlights", "skills", "motivation_draft"]) expect(t(`r0.sec.${s}`).startedAt!.getTime()).toBeGreaterThanOrEqual(wave1End);
    expect(t("r0.sec.experience").section).toBe("experience");

    // 호출: 구역 작성(본문 5 + 라운드 1 재작성), 조립 2, 피드백 1, 지원 동기 3(추천·초안·라운드 1 본문으로 다시 쓴 초안).
    expect(countCalls("resume-agent-brief")).toBe(1);
    expect(countCalls("resume-agent-section", "experience")).toBe(2);
    expect(countCalls("resume-agent-section", "extras")).toBe(1);
    expect(countCalls("resume-agent-compose")).toBe(2);
    expect(countCalls("resume-agent-critique")).toBe(1);
    expect(countCalls("resume-agent-motivation")).toBe(3);
    expect(countCalls("resume-agent-plan")).toBe(0);
    expect(countCalls("resume-agent-write")).toBe(0);

    // 문서: 누락 키워드는 근거 줄로, 근거 없는 수치는 [ADD: 수치 확인], 지원 동기 칸에 검증된 초안.
    const detail = await service.getResumeDetail("ua", job.resumeId!);
    const doc = detail!.current!.document;
    const text = layout.resumeToText(doc, "developer");
    expect(text).toContain("Redis");
    expect(text).toContain("[ADD: 수치 확인 — 장애 대응 시간을 99% 줄였다]");
    expect(doc.basics.name).toBe("홍길동");
    expect(doc.motivation).toBeTruthy();
    expect(doc.motivation).not.toContain("어릴 때부터");
    expect(doc.motivation).toContain("[ADD:");
    expect(doc.motivation).not.toMatch(/45%(?![^[]*\])/);

    // 리포트 v2.
    const report = (await jobs.getAgentReportForResume("ua", job.resumeId!))!.report;
    expect(report.version).toBe(2);
    expect(report.sections?.map((s) => s.section)).toEqual(["experience", "projects", "highlights", "skills", "extras", "motivation_draft", "motivation_suggest"]);
    expect(report.sections?.find((s) => s.section === "experience")?.rewrites).toBe(1);
    expect(report.sections?.find((s) => s.section === "experience")?.finalRound).toBe(1);
    expect(report.orchestration?.[0]?.feedback.length).toBeGreaterThan(0);
    expect(report.motivation).toMatchObject({ drafted: true, suggestionSaved: true });
    expect(report.rounds[1]!.changes.length).toBeGreaterThan(0);

    // 지원 동기 추천이 저장돼 GET이 LLM 없이 돌려준다.
    const before = state.calls.length;
    const res = await suggestRoute.GET(new Request("http://localhost/x"), ctx(job.resumeId!));
    expect(res.status).toBe(200);
    const saved = ((await res.json()) as import("@/lib/domain/resume-motivation").SavedMotivationSuggestResponse).saved;
    expect(saved?.source).toBe("agent");
    expect(saved?.jdChanged).toBe(false);
    expect(saved?.suggestion.linkedExperiences.length).toBeGreaterThan(0);
    expect(saved?.suggestion.linkedExperiences.every((e) => !/^E\d+$/.test(e.nodeId))).toBe(true);
    expect(state.calls.length).toBe(before);

    // 뷰: 구역 카드 7개(유지 칩), 총괄 피드백(E… 미노출), 근거 텍스트·노드 id 없음.
    expect(job.sections).toHaveLength(7);
    expect(job.sections!.find((s) => s.section === "highlights")!.rounds.map((r) => r.status)).toEqual(["done", "kept"]);
    expect(job.orchestrator?.[0]?.feedback.length).toBeGreaterThan(0);
    const json = JSON.stringify(job);
    expect(json).not.toMatch(/\bE\d{1,3}\b/);
    expect(json).not.toMatch(/"(p1|p2|r1|c1)"/);
  });
});

describe("v2 — 저장된 JD 분석 재사용(jd-source)", () => {
  async function seedDiagnosis(userId: string, postingId: string, jdText: string, jd: unknown) {
    await tdb.prisma.diagnosis.create({
      data: { id: `d-${userId}-${postingId}`, userId, title: "진단", targetRole: "백엔드", situation: "general", resumeText: "이력서", model: "fake", postingId, jdText, status: "done" },
    });
    await tdb.prisma.diagnosisStage.create({ data: { diagnosisId: `d-${userId}-${postingId}`, stage: "jd", status: "done", output: jd as object, finishedAt: new Date("2026-11-02T03:00:00Z") } });
  }
  async function analyzedJd(): Promise<unknown> {
    const id = await start();
    await runAfter();
    const row = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.jd" } });
    return (row.output as { jd: unknown }).jd;
  }

  it("같은 공고·같은 JD의 진단 분석은 다시 쓰고(JD 호출 0), JD를 고쳤거나 남의 진단이면 다시 분석한다", async () => {
    const jd = await analyzedJd();
    await tdb.prisma.jobPosting.create({ data: { id: "post1", userId: "ua", company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD } });
    await tdb.prisma.jobPosting.create({ data: { id: "postB", userId: "ub", company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD } });
    await seedDiagnosis("ua", "post1", `  ${AGENT_JD.replace(/\n/g, "\n\n")}  `, jd); // 공백만 다르면 같은 JD
    await seedDiagnosis("ub", "postB", AGENT_JD, jd);

    state.calls = [];
    const id = await start({ postingId: "post1" });
    await runAfter();
    expect((await view(id)).status).toBe("completed");
    expect(countCalls("jd")).toBe(0);
    const row = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.jd" } });
    expect((row.output as { reusedFrom: { kind: string; id: string } }).reusedFrom).toMatchObject({ kind: "diagnosis", id: "d-ua-post1" });
    expect(row.summary).toEqual(expect.arrayContaining([expect.stringContaining("저장된 JD 분석을 사용했습니다(진단 2026.11.0")]));
    expect(row.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    const report = (await jobs.getAgentReportForResume("ua", (await view(id)).resumeId!))!.report;
    expect(report.jdReused?.kind).toBe("diagnosis");

    // JD를 고쳤으면 다시 분석.
    state.calls = [];
    const id2 = await start({ postingId: "post1", jdText: `${AGENT_JD}\n- Go 경험` });
    await runAfter();
    expect((await view(id2)).status).toBe("completed");
    expect(countCalls("jd")).toBe(1);

    // 다른 사용자의 공고·진단은 보지 않는다(B의 공고 id를 넣어도 A의 진단만 찾는다).
    const { findReusableJdAnalysis } = await import("./jd-source");
    expect(await findReusableJdAnalysis({ userId: "ua", jdText: AGENT_JD, postingId: "postB" })).toBeNull();
    expect(await findReusableJdAnalysis({ userId: "ub", jdText: AGENT_JD, postingId: "post1" })).toBeNull();
    expect((await findReusableJdAnalysis({ userId: "ua", jdText: AGENT_JD, postingId: "post1" }))?.reusedFrom.id).toBe("d-ua-post1");
  });
});

describe("v2 — 실패·대체 경로", () => {
  it("라운드 0 경력 구역이 두 번 실패하면 세 번째 시도는 v1 본문 작성기로 대체(fallback v1_body)하고 작업은 완료된다", async () => {
    state.client = recordingClient((req, section) => (req.task === "resume-agent-section" && section === "experience" ? new Error("일시 오류") : null));
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    const row = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.sec.experience" } });
    expect(row.attempt).toBe(3);
    expect((row.output as { fallback: string }).fallback).toBe("v1_body");
    expect(countCalls("resume-agent-write")).toBeGreaterThanOrEqual(1);
    const report = (await jobs.getAgentReportForResume("ua", job.resumeId!))!.report;
    expect(report.sections?.find((s) => s.section === "experience")?.fallback).toBe(true);
    expect(job.sections!.find((s) => s.section === "experience")!.rounds[0]!.fallback).toBe(true);
  });

  it("같은 배치의 경력·프로젝트가 함께 마지막 시도로 가면 v1 본문 작성기 호출을 한 번만 나눠 쓴다(같은 단계 재작성 없음)", async () => {
    state.client = recordingClient((req, section) => (req.task === "resume-agent-section" && (section === "experience" || section === "projects") ? new Error("일시 오류") : null));
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    for (const key of ["r0.sec.experience", "r0.sec.projects"]) {
      const row = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key } });
      expect(row.attempt).toBe(3);
      expect((row.output as { fallback: string; retried: boolean }).fallback).toBe("v1_body");
      expect((row.output as { retried: boolean }).retried).toBe(false);
    }
    expect(countCalls("resume-agent-write")).toBe(1);
  });

  it("수상·기타 구역이 실패해도 작업은 실패하지 않고 그 칸을 비운 채 진행한다", async () => {
    state.client = recordingClient((req, section) => (req.task === "resume-agent-section" && section === "extras" ? new LlmPermanentError("x", "invalid_output") : null));
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect((await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.sec.extras" } })).status).toBe("failed");
    const compose = (await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.compose" } })).output as { draft: { notes: string[] } };
    expect(compose.draft.notes.join(" ")).toContain("수상·기타 구역을 쓰지 못해");
  });

  it("다시 시도(v2)는 실패로 닫은 단계만 되살리고, 계획이 처리한 실패(재작성 구역 → 이전 결과)는 그대로 둔다", async () => {
    state.client = recordingClient((req, section) =>
      req.task === "resume-agent-section" && section === "experience" && req.user.includes("orchestrator_feedback") ? new LlmPermanentError("x", "invalid_output") : null,
    );
    const id = await startDetached();
    const chain = async () => ({ ok: true as const });
    const onStepStart = async (key: string) => {
      if (key !== "finalize") return;
      await tdb.prisma.resumeAgentStep.updateMany({ where: { jobId: id, key: "finalize" }, data: { status: "failed", error: "가짜 저장 실패" } });
      await tdb.prisma.resumeAgentJob.updateMany({ where: { id }, data: { status: "failed", failedStep: "finalize", leaseId: null, leaseExpiresAt: null } });
      throw new Error("stop");
    };
    for (let i = 0; i < 40 && (await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).status !== "failed"; i++) await jobs.advanceAgentJob(id, { deps: { chain, onStepStart } });
    expect((await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r1.sec.experience" } })).status).toBe("failed");
    const before = state.calls.length;
    const res = await retryRoute.POST(new Request("http://localhost/x", { method: "POST" }), ctx(id));
    expect(res.status).toBe(202);
    expect((await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r1.sec.experience" } })).status).toBe("failed");
    expect((await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "finalize" } })).status).toBe("pending");
    state.client = recordingClient();
    await runAfter();
    expect((await view(id)).status).toBe("completed");
    // 저장만 다시 했다(구역·심사·총괄을 새로 돌지 않는다).
    expect(state.calls.slice(before).filter((c) => c.label.startsWith("resume-agent-section") || c.label === "resume-agent-critique")).toHaveLength(0);
  });

  it("계획 설정(재작성 횟수 등)은 시작 때 고정한다 — 이어 가는 동안 환경 변수가 바뀌어도 그대로", async () => {
    process.env.RESUME_AGENT_MAX_REVISIONS = "0";
    const id = await startDetached();
    delete process.env.RESUME_AGENT_MAX_REVISIONS;
    expect(((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).progress as { pinned: { maxRevisions: number } }).pinned.maxRevisions).toBe(0);
    for (let i = 0; i < 40 && (await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).status !== "completed"; i++) await jobs.advanceAgentJob(id, { deps: { chain: async () => ({ ok: true as const }) } });
    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(job.stopReason).toBe("max_rounds");
    expect(countCalls("resume-agent-critique")).toBe(0);
  });

  it("라운드 1 구역 재작성이 3번 실패하면 이전 라운드 출력을 그대로 쓰고 작업은 계속된다", async () => {
    let r1 = 0;
    state.client = recordingClient((req, section) => {
      if (req.task !== "resume-agent-section" || section !== "experience") return null;
      if (!req.user.includes("orchestrator_feedback")) return null;
      r1++;
      return new LlmPermanentError("가짜 영구 오류", "invalid_output");
    });
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(r1).toBeGreaterThanOrEqual(1);
    const row = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r1.sec.experience" } });
    expect(row.status).toBe("failed");
    const compose = (await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r1.compose" } })).output as { sectionsUsed: { section: string; round: number; fallback: boolean }[] };
    expect(compose.sectionsUsed.find((u) => u.section === "experience")).toMatchObject({ round: 0, fallback: true });
    expect(job.sections!.find((s) => s.section === "experience")!.rounds[1]).toMatchObject({ status: "failed", fallback: true });
  });

  it("지원 동기 추천이 실패해도 초안은 쓰고(재료 없이), 추천은 저장하지 않는다 — 작업 실패 사유가 아니다", async () => {
    state.client = recordingClient((req) => (req.task === "resume-agent-motivation" && !req.user.includes("지원 동기 초안 작성(구역 에이전트)") ? new LlmPermanentError("x", "invalid_output") : null));
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    const doc = (await service.getResumeDetail("ua", job.resumeId!))!.current!.document;
    expect(doc.motivation).toBeTruthy();
    expect(await tdb.prisma.resumeMotivationSuggestion.count()).toBe(0);
    const report = (await jobs.getAgentReportForResume("ua", job.resumeId!))!.report;
    expect(report.motivation).toMatchObject({ drafted: true, suggestionSaved: false });
  });

  it("공용 이력서는 지원 동기 에이전트를 돌리지 않는다(카드 건너뜀, 칸 비움)", async () => {
    const id = await start({ kind: "general", company: "", roleTitle: "", jdText: "" });
    await runAfter();
    const job = await view(id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(countCalls("resume-agent-motivation")).toBe(0);
    expect(job.sections!.filter((s) => s.skipped).map((s) => s.section).sort()).toEqual(["motivation_draft", "motivation_suggest"]);
    const doc = (await service.getResumeDetail("ua", job.resumeId!))!.current!.document;
    expect(doc.motivation).toBe("");
  });

  it("RESUME_AGENT_MOTIVATION=0이면 지원처별 이력서도 지원 동기 에이전트를 끈다", async () => {
    process.env.RESUME_AGENT_MOTIVATION = "0";
    const id = await start();
    await runAfter();
    expect((await view(id)).status).toBe("completed");
    expect(countCalls("resume-agent-motivation")).toBe(0);
  });

  it("RESUME_AGENT_MAX_REVISIONS=0이면 첫 심사 뒤 총괄 피드백 없이 끝난다(마지막 라운드 critique 생략)", async () => {
    process.env.RESUME_AGENT_MAX_REVISIONS = "0";
    const id = await start();
    await runAfter();
    const job = await view(id);
    expect(job.stopReason).toBe("max_rounds");
    expect(countCalls("resume-agent-critique")).toBe(0);
    expect(await stepKeys(id)).not.toContain("r0.critique");
  });
});

describe("v2 — 시간 예산·리스·버전", () => {
  it("배치는 가장 긴 추정 + 여유가 남을 때만 시작하고 모자라면 줄이지 않고 다음 호출로 넘긴다", async () => {
    const id = await startDetached();
    const chain = vi.fn(async () => ({ ok: true as const }));
    let t = Date.now();
    // 호출마다 200초 예산(웨이브 1의 경력 추정 150초 + 여유 15초는 첫 배치로만 들어간다).
    const batches: string[][] = [];
    for (let i = 0; i < 40; i++) {
      const before = new Set(await stepKeys(id));
      const now = () => t;
      await jobs.advanceAgentJob(id, { deadlineAt: t + 200_000, deps: { chain, now, onStepStart: async () => void (t += 40_000) } });
      const after = await stepKeys(id);
      batches.push(after.filter((k) => !before.has(k)));
      const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
      if (row.status === "completed" || row.status === "failed") break;
    }
    expect((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).status).toBe("completed");
    // 웨이브 1의 구역 4개는 같은 호출에서 함께 시작했다(일부만 시작하지 않는다).
    const wave1 = ["r0.sec.experience", "r0.sec.projects", "r0.sec.extras", "r0.sec.motivation_suggest"];
    const holder = batches.find((b) => b.some((k) => wave1.includes(k)))!;
    for (const k of wave1) expect(holder).toContain(k);
    expect(chain.mock.calls.length).toBeGreaterThan(2);
  });

  it("호출 마감 판정: 단계 상한이 한 호출보다 길면(Anthropic 밖 엔진) 새 호출 첫 배치의 시간 초과는 시도로 센다", () => {
    const vercelMax = jobs.callMaxStepMs({ VERCEL: "1" });
    expect(vercelMax).toBe(255_000);
    // 경력 230초 × 1.5 = 345초 > 255초: 첫 배치(약 250초)의 시간 초과는 '마감 탓'이 아니다 → 시도로 센다.
    expect(jobs.capWasClamped(250_000, 345_000, vercelMax)).toBe(false);
    // 같은 호출의 뒤 배치(150초만 남음)는 마감 탓 → 새 호출로.
    expect(jobs.capWasClamped(150_000, 345_000, vercelMax)).toBe(true);
    // 상한이 한 호출 안에 들어가면 예전 규칙 그대로.
    expect(jobs.capWasClamped(25_000, 120_000, vercelMax)).toBe(true);
    expect(jobs.capWasClamped(120_000, 120_000, vercelMax)).toBe(false);
    expect(jobs.capWasClamped(25_000, 120_000, jobs.callMaxStepMs({}))).toBe(true);
  });

  it("병렬 배치 중 리스를 잃으면 모든 구역이 멈추고 어느 구역도 done으로 쓰지 않는다", async () => {
    state.client = recordingClient(undefined, 60);
    const id = await startDetached();
    await jobs.advanceAgentJob(id, { deps: { maxStepsPerCall: 3, chain: async () => ({ ok: true as const }) } }); // jd·retrieve·brief
    let stolen = false;
    await jobs.advanceAgentJob(id, {
      deps: {
        heartbeatMs: 10,
        chain: async () => ({ ok: true as const }),
        onStepStart: async () => {
          if (stolen) return;
          stolen = true;
          await tdb.prisma.resumeAgentJob.update({ where: { id }, data: { leaseId: "someone-else" } });
        },
      },
    });
    const rows = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id, key: { startsWith: "r0.sec." } } });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.status === "done")).toHaveLength(0);
  });

  it("버전 고정: 기존 v1 작업은 v1 단계로 끝까지, 다시 시도해도 버전이 바뀌지 않는다", async () => {
    process.env.RESUME_AGENT_PIPELINE = "1";
    const id = await startDetached();
    delete process.env.RESUME_AGENT_PIPELINE; // 배포가 v2로 바뀌어도
    expect((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).pipelineVersion).toBe(1);
    state.client = recordingClient((req) => (req.task === "resume-agent-plan" ? new LlmPermanentError("x", "invalid_output") : null));
    await jobs.advanceAgentJob(id, { deps: { chain: async () => ({ ok: true as const }) } });
    expect((await view(id)).status).toBe("failed");
    state.client = recordingClient();
    const res = await retryRoute.POST(new Request("http://localhost/x", { method: "POST" }), ctx(id));
    expect(res.status).toBe(202);
    await runAfter();
    const job = await view(id);
    expect(job.status).toBe("completed");
    expect(job.pipelineVersion).toBe(1);
    expect((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } })).pipelineVersion).toBe(1);
    expect(await stepKeys(id)).toContain("r0.plan");
    expect(countCalls("resume-agent-section")).toBe(0);
  });
});

describe("v2 — 다시 생성·추천 버튼·격리", () => {
  async function makeResume(motivation: string): Promise<string> {
    const id = await start();
    await runAfter();
    const resumeId = (await view(id)).resumeId!;
    const detail = (await service.getResumeDetail("ua", resumeId))!;
    await service.saveVersion("ua", resumeId, { ...detail.current!.document, motivation }, { source: "manual" });
    await tdb.prisma.resumeAgentJob.update({ where: { id }, data: { completedAt: new Date(Date.now() - 60_000) } });
    return resumeId;
  }
  async function regenerate(resumeId: string): Promise<void> {
    const route = await import("@/app/api/resumes/[id]/regenerate/route");
    const res = await route.POST(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "agent" }) }), ctx(resumeId));
    expect(res.status).toBe(202);
    await runAfter();
  }

  it("다시 생성: 사용자가 쓴 지원 동기는 그대로, 비어 있으면 새 초안으로 채운다", async () => {
    const kept = await makeResume("제가 직접 쓴 지원 동기입니다.");
    await regenerate(kept);
    expect((await service.getResumeDetail("ua", kept))!.current!.document.motivation).toBe("제가 직접 쓴 지원 동기입니다.");

    const filled = await makeResume("");
    await regenerate(filled);
    const doc = (await service.getResumeDetail("ua", filled))!.current!.document;
    expect(doc.motivation).toContain("[ADD:");
  });

  it("추천 버튼: 같은 이력서의 이전 작업 JD 분석을 함께 넘기고 결과를 저장한다. 남의 이력서는 GET·POST 모두 404", async () => {
    const id = await start();
    await runAfter();
    const resumeId = (await view(id)).resumeId!;
    state.calls = [];
    const res = await suggestRoute.POST(
      new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ motivation: "" }) }),
      ctx(resumeId),
    );
    expect(res.status).toBe(200);
    const call = state.calls.find((c) => c.label === "resume-motivation-suggest")!;
    expect(call.user).toContain("저장된 JD 분석");
    expect(call.user).not.toContain(B_MARK);
    const saved = (await (await suggestRoute.GET(new Request("http://localhost/x"), ctx(resumeId))).json()) as { saved: { source: string } };
    expect(saved.saved.source).toBe("button");
    // JD가 바뀌면 다시 받기 안내.
    await tdb.prisma.companyResume.update({ where: { id: resumeId }, data: { jdText: `${AGENT_JD}\n- 새 요건` } });
    const changed = (await (await suggestRoute.GET(new Request("http://localhost/x"), ctx(resumeId))).json()) as { saved: { jdChanged: boolean } };
    expect(changed.saved.jdChanged).toBe(true);

    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await suggestRoute.GET(new Request("http://localhost/x"), ctx(resumeId))).status).toBe(404);
    const post2 = await suggestRoute.POST(new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), ctx(resumeId));
    expect(post2.status).toBe(404);
  });

  it("A의 v2 작업: 모든 프롬프트에 B의 그래프·진단·이름·메일·노드 id가 없고, 단계 출력·뷰에도 B 데이터가 없다", async () => {
    await tdb.prisma.jobPosting.create({ data: { id: "pb", userId: "ub", company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD } });
    await tdb.prisma.diagnosis.create({ data: { id: "db1", userId: "ub", title: B_MARK, targetRole: "x", situation: "general", resumeText: B_MARK, model: "fake", postingId: "pb", jdText: AGENT_JD, status: "done" } });
    await tdb.prisma.diagnosisStage.create({ data: { diagnosisId: "db1", stage: "jd", status: "done", output: { bogus: B_MARK } } });
    const id = await start();
    await runAfter();
    expect((await view(id)).status).toBe("completed");
    const bStrings = [B_MARK, "9999건", "8888억", "ub@x.com", "비밀B", "ua@x.com", "홍길동"];
    for (const c of state.calls) {
      for (const s of bStrings) expect(c.user.includes(s), `${c.label}/${c.section}: ${s}`).toBe(false);
      expect(/\b(p1|p2|r1|c1|s_kafka|bp1|br1)\b/.test(c.user), `${c.label}/${c.section}`).toBe(false);
    }
    const steps = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } });
    expect(JSON.stringify(steps)).not.toContain(B_MARK);
    expect(JSON.stringify(await view(id))).not.toContain(B_MARK);
  });
});
