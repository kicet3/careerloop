import "server-only";
/**
 * 그래프 이력서 에이전트 작업(resume_agent_jobs·resume_agent_steps). 설계는 docs/RESUME-AGENT.md §3.
 *
 * 실행 모델(Vercel Hobby, 함수 1회 300초): 한 호출 안에서는 시간이 허락하는 만큼 단계를 진행하고, 모자라면 'waiting'으로 두고
 * 서명된 내부 자기 호출(chain.ts)로 다음 호출을 연다. 진행 화면 폴링(needsKick → POST …/advance)·목록 렌더·알림 sweep이 안전망이다.
 *
 * - 리스: 단계를 실행하는 호출만 lease_id를 잡는다(조건부 update 하나 — 경쟁하는 두 호출 중 하나만). 60초 리스를 20초마다 연장한다.
 *   함수가 강제 종료되면 하트비트가 멈추고 60초 뒤 다른 호출이 이어받는다.
 * - 모든 쓰기는 작업 행의 run_id·lease_id 조건. 단계 완료는 (job_id, key) 행이 아직 done이 아니고 리스가 내 것일 때만.
 * - 다음 단계는 저장된 단계 행만으로 계산한다(next-step.ts evaluateRun) — 어느 호출이 이어받아도 같은 결정.
 * - userId는 언제나 작업 행에서 읽는다(요청 본문·내부 호출 본문의 userId는 받지 않는다). 그래프는 loadAgentGraph로만.
 * - 로그에는 작업 id·단계 키·오류 분류만 남긴다(프롬프트·근거·JD 없음).
 */
import { nanoid } from "nanoid";
import { z } from "zod";
import { FeatureError } from "@/lib/api/errors";
import { prisma, Prisma } from "@/lib/db/client";
import { stripNul, stripNulDeep } from "@/lib/db/errors";
import type { UsageTotals } from "@/lib/db/types";
import { runDeadline } from "@/lib/diagnoses/deadline";
import { isProviderId, type ProviderId } from "@/lib/domain/providers";
import { graphEnabled } from "@/lib/graph/service";
import { createLlmClient, LlmPermanentError, type LlmClient, type LlmUsageContext } from "@/lib/llm";
import { usageOfError } from "@/lib/llm/types";
import { notify } from "@/lib/notifications/service";
import { stageErrorMessage } from "@/lib/panel/runner";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { assertResumeSlots, DRAFT_JOB_RETENTION_MS, draftJobLabel, FAILED_JOB_LIST_MS } from "@/lib/resumes/draft-jobs";
import type { ResumeDraftJobView } from "@/lib/resumes/draft-job-types";
import { CreateResumeInputSchema, type CreateResumeInput } from "@/lib/resumes/types";
import { agentEnabledFor, agentSettings, type AgentSettings } from "./config";
import { chainEnabled, requestChain, type ChainResult } from "./chain";
import { hasAgentGraphMaterial, loadAgentGraph } from "./evidence";
import {
  AGENT_STEP_LABELS,
  parseStepKey,
  stepTitle,
  type AgentErrorCode,
  type AgentStepKind,
  type AgentStepView,
  type FinalPanelView,
  type ResumeAgentJobStatus,
  type ResumeAgentJobView,
  type RoundScoreView,
} from "./job-types";
import { evaluateRun, MAX_STEP_ATTEMPTS, parsedOutput, STEP_CAP_SEC, STEP_ESTIMATE_SEC, STEP_OUTPUT_SCHEMAS, STEP_TOKEN_ESTIMATE, type StepRowLike } from "./next-step";
import { AGENT_SCHEMA_VERSION, type AgentReport } from "./schemas";
import { prepareFinalize } from "./steps/finalize";
import { runJdStep } from "./steps/jd";
import { runPlanStep } from "./steps/plan";
import { runRetrieveStep } from "./steps/retrieve";
import { runFinalPanelStep, runReviewStep } from "./steps/review";
import { runReviseStep } from "./steps/revise";
import { addUsage, AgentStepError, ZERO_USAGE, type StepContext, type StepResult } from "./steps/shared";
import { runWriteBodyStep, runWriteTopStep } from "./steps/write";

/** 에이전트 라우트(시작·이어 가기·다시 시도·내부 연쇄)의 maxDuration과 같아야 한다(라우트는 리터럴로 적는다). */
export const AGENT_ROUTE_MAX_DURATION_SEC = 300;
/** 자체 호스팅(플랫폼 시간 제한 없음)의 한 호출 예산. */
export const SELF_HOSTED_AGENT_TIME_LIMIT_MS = 20 * 60_000;
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const MAX_ACTIVE_AGENT_JOBS = 1;
export const MAX_CONTINUATIONS = 20;
/** waiting으로 이만큼 멈춰 있으면 실패로 닫는다(연쇄가 막혀도 그 전에는 다음 접속 때 이어 간다). */
export const AGENT_IDLE_FAIL_MS = 24 * 60 * 60_000;
/** waiting이 이만큼 머물면(연쇄가 안 온 것으로 보고) 안전망이 이어 가기를 요청한다. */
export const IDLE_KICK_MS = 30_000;
/** 패널 프롬프트는 JD를 자르지 않으므로 작업 시작 때 한 번 자른다(모든 단계가 같은 JD를 본다). */
export const AGENT_JD_MAX_CHARS = 12_000;
/** 단계 시작 여유(단계 상한 = min(cap, 남은 시간 − 이 값)). */
const STEP_MARGIN_MS = 15_000;
/** 오류로 멈춘 뒤 다음 호출을 열기 전 대기. */
const CHAIN_DELAY_AFTER_ERROR_MS = 3_000;

export const AGENT_JOB_NOT_FOUND = "에이전트 작업을 찾을 수 없습니다.";
const IDLE_ERROR = "오래 멈춰 있던 작업을 닫았습니다. 다시 시도하면 끝난 단계는 건너뜁니다.";
const SCHEMA_ERROR = "서비스 업데이트로 다시 시작이 필요합니다. 다시 시도해 주세요.";
const CONTINUATIONS_ERROR = "작업이 너무 여러 번 이어져 멈췄습니다. 다시 시도하면 끝난 단계는 건너뜁니다.";
const INPUT_ERROR = "작업 정보가 만료됐습니다. 새 이력서 화면에서 다시 만들어 주세요.";
const INTERRUPTED_ERROR = "단계가 여러 번 중간에 끊겨 끝내지 못했습니다. 다시 시도해 주세요.";

const ACTIVE = ["running", "waiting"] as const;

/** finalize 단계 행 output: 만들기 직전에 적어 둔 이력서 id(완료 기록 전에 끊기면 다음 시도가 지운다). */
const PendingResumeSchema = z.object({ pendingResumeId: z.string().min(1).max(40) });

type JobRow = Prisma.ResumeAgentJobGetPayload<object>;
type StepRow = Prisma.ResumeAgentStepGetPayload<object>;

/** 사용자에게 보이는지(RESUME_AGENT 플래그 + 그래프 저장소 + 그 사용자의 그래프에 노드가 있음). */
export async function agentAvailableFor(
  user: { id: string; email?: string | null },
  env: Record<string, string | undefined> = process.env,
  deps: { hasMaterial?: (userId: string) => Promise<boolean> } = {},
): Promise<boolean> {
  if (!graphEnabled() || !agentEnabledFor(user, env)) return false;
  return (deps.hasMaterial ?? hasAgentGraphMaterial)(user.id);
}

/** 한 호출의 마감 시각(요청 시작 기준). Vercel은 maxDuration − 30초, 그 밖은 자체 호스팅 예산. */
export function agentDeadline(startedAt: number, env: Record<string, string | undefined> = process.env): number {
  return runDeadline(startedAt, AGENT_ROUTE_MAX_DURATION_SEC, env) ?? startedAt + SELF_HOSTED_AGENT_TIME_LIMIT_MS;
}

export class AgentBusyError extends FeatureError {
  constructor(readonly jobId: string) {
    super("진행 중인 에이전트 작업이 있습니다. 끝난 뒤 다시 시작하거나 진행 화면에서 확인해 주세요.", 409);
    this.name = "AgentBusyError";
  }
}

// ---------------------------------------------------------------------------
// 뷰
// ---------------------------------------------------------------------------

const STEP_ORDER = ["r0.jd", "r0.retrieve", "r0.plan", "r0.write_body", "r0.write_top", "r0.review", "r1.revise", "r1.review", "r2.revise", "r2.review", "final_panel", "finalize"];

interface Progress {
  coverage?: ResumeAgentJobView["coverage"];
  rounds?: RoundScoreView[];
  finalPanel?: FinalPanelView | null;
  stopReason?: ResumeAgentJobView["stopReason"];
  previewText?: string | null;
  errorCode?: AgentErrorCode | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : []);

function stepViews(rows: readonly StepRow[]): AgentStepView[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const views: AgentStepView[] = [];
  for (const key of STEP_ORDER) {
    const row = byKey.get(key);
    const parsed = parseStepKey(key)!;
    // 수정·심사 라운드는 실제로 생긴 행만 보인다(r0 단계와 최종 단계는 자리를 미리 보인다).
    if (!row && parsed.round >= 1) continue;
    views.push({
      key,
      kind: parsed.kind,
      round: parsed.round,
      status: (row?.status as AgentStepView["status"]) ?? "pending",
      summary: strings(row?.summary),
      error: row?.status === "failed" || (row?.status === "pending" && row.error) ? row.error : null,
      startedAt: row?.startedAt?.getTime() ?? null,
      finishedAt: row?.finishedAt?.getTime() ?? null,
    });
  }
  return views;
}

export function toAgentJobView(job: JobRow, rows: readonly StepRow[], now: number = Date.now()): ResumeAgentJobView {
  const progress = (job.progress ?? {}) as Progress;
  const status = job.status as ResumeAgentJobStatus;
  const waitingIdle = status === "waiting" && job.leaseId === null && now - job.updatedAt.getTime() > (chainEnabled() ? IDLE_KICK_MS : 0);
  const leaseLost = status === "running" && !!job.leaseExpiresAt && job.leaseExpiresAt.getTime() < now;
  return {
    id: job.id,
    mode: "agent",
    status,
    label: job.label,
    currentStep: job.currentStep,
    steps: stepViews(rows),
    rounds: progress.rounds ?? [],
    finalPanel: progress.finalPanel ?? null,
    coverage: progress.coverage ?? null,
    stopReason: progress.stopReason ?? null,
    error: job.error,
    errorCode: progress.errorCode ?? null,
    failedStep: job.failedStep,
    canRetry: status === "failed" && job.input !== null && progress.errorCode !== "insufficient_graph",
    canFallback: (status === "failed" || status === "canceled") && job.input !== null,
    needsKick: waitingIdle || leaseLost,
    chainEnabled: chainEnabled(),
    resumeId: job.resumeId,
    previewText: progress.previewText ?? null,
    attempts: job.attempts,
    startedAt: job.startedAt.getTime(),
    createdAt: job.createdAt.getTime(),
    updatedAt: job.updatedAt.getTime(),
    completedAt: job.completedAt?.getTime() ?? null,
  };
}

/** 단계 행 → 진행 화면 요약(라운드 점수·커버리지·최선 초안 미리 보기). 근거 텍스트·노드 id는 담지 않는다. */
function progressFrom(rows: readonly StepRowLike[], settings: AgentSettings, prev: Progress): Progress {
  const state = evaluateRun(rows, { maxRevisions: settings.maxRevisions, minFit: settings.minFit, panel: settings.panel });
  const ret = parsedOutput(rows, "retrieve", 0);
  const rounds: RoundScoreView[] = state.rounds.map((r) => ({
    round: r.round,
    passCount: r.passCount,
    passTotal: r.passTotal,
    matchScore: r.matchScore,
    panelScore: r.panelScore,
    atsPass: r.atsPass,
    incomplete: r.incomplete,
    verdicts: r.verdicts,
  }));
  let previewText: string | null = prev.previewText ?? null;
  const best = state.chosenRound;
  if (best !== null) previewText = best === 0 ? (parsedOutput(rows, "write_top", 0)?.previewText ?? previewText) : (parsedOutput(rows, "revise", best)?.previewText ?? previewText);
  else previewText = parsedOutput(rows, "write_top", 0)?.previewText ?? previewText;
  const final = parsedOutput(rows, "final_panel", -1);
  let finalPanel: FinalPanelView | null = null;
  const chosen = state.rounds.find((r) => r.round === best);
  if (final && chosen) {
    const verdicts = [...chosen.verdicts.map((v) => ({ ...v, verdict: v.verdict as string | null })), ...final.verdicts];
    finalPanel = { passCount: verdicts.filter((v) => v.positive).length, total: 7, verdicts };
  }
  const settled = state.next === null || state.next.kind === "final_panel" || state.next.kind === "finalize";
  return { ...prev, coverage: ret?.pack.coverage ?? prev.coverage ?? null, rounds, finalPanel, stopReason: settled ? state.stopReason : null, previewText };
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

async function lockAgentJobs(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`resume-agent:${userId}`}))`;
}

async function activeAgentJob(userId: string, db: Prisma.TransactionClient = prisma, exceptId?: string): Promise<string | null> {
  const row = await db.resumeAgentJob.findFirst({
    select: { id: true },
    where: { userId, status: { in: [...ACTIVE] }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return row?.id ?? null;
}

/** 진행 중(running·waiting) 에이전트 작업 수 — 이력서 수 상한(assertResumeSlots)이 함께 센다. */
export async function countActiveAgentJobs(userId: string, db: Prisma.TransactionClient = prisma): Promise<number> {
  return db.resumeAgentJob.count({ where: { userId, status: { in: [...ACTIVE] } } });
}

/** 끝난 지 오래된 작업 정리(그 사용자 행만): 7일 지난 완료 작업의 단계 출력을 비우고, 7일 지난 실패·취소 작업은 지운다. */
async function cleanupOldJobs(userId: string, now: number): Promise<void> {
  const before = new Date(now - DRAFT_JOB_RETENTION_MS);
  await prisma.resumeAgentStep
    .updateMany({ where: { job: { userId, status: "completed", completedAt: { lt: before } }, output: { not: Prisma.DbNull } }, data: { output: Prisma.DbNull } })
    .catch(() => undefined);
  await prisma.resumeAgentJob
    .deleteMany({ where: { userId, status: { in: ["failed", "canceled"] }, updatedAt: { lt: before } } })
    .catch(() => undefined);
}

export interface StartAgentDeps {
  now?: () => number;
  resolveProvider?: (requested: string | null) => Promise<ProviderId>;
  /** 레이트 리밋(다른 확인 뒤 — 잘못된 요청이 한도를 깎지 않게). */
  beforeCreate?: () => Promise<void>;
  env?: Record<string, string | undefined>;
}

/** 에이전트 작업 시작: 입력·엔진·동시 작업·이력서 수를 확인하고 작업 행을 만든다(advisory lock 안에서 한 번 더 센다). */
export async function startResumeAgentJob(
  user: { id: string; name: string | null; email?: string | null },
  input: CreateResumeInput,
  deps: StartAgentDeps = {},
): Promise<{ job: ResumeAgentJobView; runId: string }> {
  if (input.source.kind !== "graph" || input.sourceResumeId) throw new FeatureError("에이전트는 경험 그래프 출처에서만 쓸 수 있습니다.", 400);
  if (!graphEnabled()) throw new FeatureError("경험 그래프 저장소(Neo4j)가 설정되지 않아 그래프에서 초안을 만들 수 없습니다.", 503);
  const now = deps.now?.() ?? Date.now();
  const env = deps.env ?? process.env;
  const provider = await (deps.resolveProvider ?? resolveRequestedProvider)(input.provider ?? null);
  const busy = await activeAgentJob(user.id);
  if (busy) throw new AgentBusyError(busy);
  await assertResumeSlots(user.id, now);
  await deps.beforeCreate?.();
  await cleanupOldJobs(user.id, now);

  const runId = nanoid();
  const general = input.kind === "general";
  const stored: CreateResumeInput = { ...input, jdText: general ? "" : input.jdText.slice(0, AGENT_JD_MAX_CHARS), provider };
  const row = await prisma.$transaction(async (tx) => {
    await lockAgentJobs(tx, user.id);
    const again = await activeAgentJob(user.id, tx);
    if (again) throw new AgentBusyError(again);
    await assertResumeSlots(user.id, now, tx);
    return tx.resumeAgentJob.create({
      data: {
        id: nanoid(16),
        userId: user.id,
        runId,
        status: "waiting",
        currentStep: "r0.jd",
        label: stripNul(draftJobLabel(input)),
        input: stripNulDeep(stored) as Prisma.InputJsonValue,
        provider,
        deploymentId: env.VERCEL_DEPLOYMENT_ID?.slice(0, 120) ?? null,
        schemaVersion: AGENT_SCHEMA_VERSION,
        startedAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
  });
  return { job: toAgentJobView(row, [], now), runId };
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

export interface AdvanceDeps {
  createClient?: (provider: ProviderId, usage: LlmUsageContext) => LlmClient;
  now?: () => number;
  loadGraph?: StepContext["loadGraph"];
  /** 다음 호출 요청(기본 chain.ts requestChain). */
  chain?: (job: { id: string; runId: string }) => Promise<ChainResult>;
  /** 테스트용: 한 호출에서 실행할 단계 수 상한(시간 예산을 작게 준 것과 같다). */
  maxStepsPerCall?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  nowYear?: number;
  settings?: AgentSettings;
  /** 테스트용: 단계를 시작한 직후(하트비트 중단·강제 종료 흉내). */
  onStepStart?: (key: string) => Promise<void>;
  /** 시간 부족이 아닌 이유로 멈춘 뒤 다음 호출을 열기 전 대기(기본 CHAIN_DELAY_AFTER_ERROR_MS). */
  chainDelayMs?: number;
  /** 테스트용: 단계 시간 상한 신호(기본 AbortSignal.timeout). */
  timeoutSignal?: (ms: number) => AbortSignal;
  /** 테스트용: finalize에서 이력서를 만든 직후(완료 기록 전 강제 종료 흉내). */
  onResumeCreated?: (resumeId: string) => Promise<void>;
}

class LostOwnershipError extends Error {
  constructor() {
    super("lost_ownership");
    this.name = "LostOwnershipError";
  }
}

/** 사용자에게 보일 실패 문구. */
export function agentStepErrorMessage(err: unknown): string {
  if (err instanceof AgentStepError || err instanceof FeatureError) return err.message;
  if (err instanceof LlmPermanentError) return stageErrorMessage(err);
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "단계가 시간 안에 끝나지 않아 다시 시도합니다.";
  return stageErrorMessage(err);
}

function isPermanent(err: unknown): boolean {
  if (err instanceof AgentStepError) return err.permanent;
  if (err instanceof LlmPermanentError) return err.reason !== "max_tokens" && err.reason !== "timeout";
  if (err instanceof FeatureError) return err.status !== 504 && err.status < 500;
  return (err as { name?: string })?.name === "GraphOwnerMismatchError";
}

function errorCodeOf(err: unknown): AgentErrorCode {
  return err instanceof AgentStepError && err.code === "insufficient_graph" ? "insufficient_graph" : "step_failed";
}

async function notifyAgentFailed(userId: string, jobId: string, label: string, error: string): Promise<void> {
  await notify(userId, { kind: "resume-agent-failed", title: "AI 에이전트가 이력서를 끝내지 못했습니다", body: `${label} — ${error}`, link: `/app/resumes/agent/${jobId}` });
}

/** 작업을 실패로 닫는다(실행 중 조건). 닫았으면 알림. */
async function failJob(job: Pick<JobRow, "id" | "userId" | "runId" | "label" | "progress">, code: AgentErrorCode, message: string, failedStep: string | null, now: number): Promise<boolean> {
  const progress = { ...((job.progress ?? {}) as Progress), errorCode: code };
  const { count } = await prisma.resumeAgentJob.updateMany({
    where: { id: job.id, runId: job.runId, status: { in: [...ACTIVE] } },
    data: { status: "failed", error: stripNul(message), failedStep, leaseId: null, leaseExpiresAt: null, progress: progress as unknown as Prisma.InputJsonValue, updatedAt: new Date(now) },
  });
  if (count > 0) await notifyAgentFailed(job.userId, job.id, job.label, message);
  return count > 0;
}

async function runStep(kind: AgentStepKind, round: number, ctx: StepContext): Promise<StepResult> {
  switch (kind) {
    case "jd":
      return runJdStep(ctx);
    case "retrieve":
      return runRetrieveStep(ctx);
    case "plan":
      return runPlanStep(ctx);
    case "write_body":
      return runWriteBodyStep(ctx);
    case "write_top":
      return runWriteTopStep(ctx);
    case "review":
      return runReviewStep(ctx, round);
    case "revise":
      return runReviseStep(ctx, round);
    case "final_panel":
      return runFinalPanelStep(ctx);
    case "finalize":
      throw new Error("finalize는 따로 실행한다");
  }
}

async function discardResume(userId: string, resumeId: string): Promise<void> {
  try {
    const { deleteResume } = await import("@/lib/resumes/service");
    await deleteResume(userId, resumeId);
  } catch (err) {
    console.error("[resume agent] 버려진 이력서 삭제 실패", resumeId, (err as Error)?.name);
  }
}

/**
 * 작업을 이어서 실행한다(라우트의 after()에서). 던지지 않는다. 리스를 못 잡으면(다른 호출이 실행 중) 아무것도 하지 않는다.
 * opts.userId·runId를 주면 그 조건으로만 찾는다(사용자 라우트는 세션 userId, 내부 연쇄는 서명된 runId).
 */
export async function advanceAgentJob(jobId: string, opts: { userId?: string; runId?: string; deadlineAt?: number; deps?: AdvanceDeps } = {}): Promise<void> {
  const deps = opts.deps ?? {};
  const now = deps.now ?? Date.now;
  const settings = deps.settings ?? agentSettings();
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const deadlineAt = opts.deadlineAt ?? agentDeadline(now());
  let job = await prisma.resumeAgentJob.findFirst({
    where: { id: jobId, ...(opts.userId ? { userId: opts.userId } : {}), ...(opts.runId ? { runId: opts.runId } : {}), status: { in: [...ACTIVE] } },
  });
  if (!job) return;
  if (job.schemaVersion !== AGENT_SCHEMA_VERSION) {
    await failJob(job, "schema_version", SCHEMA_ERROR, job.currentStep, now());
    return;
  }
  const parsedInput = CreateResumeInputSchema.safeParse(job.input);
  if (!parsedInput.success) {
    await failJob(job, "input_missing", INPUT_ERROR, job.currentStep, now());
    return;
  }

  const leaseId = nanoid();
  const [claimed] = await prisma.resumeAgentJob.updateManyAndReturn({
    where: { id: job.id, runId: job.runId, status: { in: [...ACTIVE] }, OR: [{ leaseId: null }, { leaseExpiresAt: { lt: new Date(now()) } }] },
    data: { leaseId, leaseExpiresAt: new Date(now() + leaseMs), status: "running", updatedAt: new Date(now()) },
  });
  if (!claimed) return;
  job = claimed;
  const mineLease = { id: job.id, runId: job.runId, leaseId } satisfies Prisma.ResumeAgentJobWhereInput;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void prisma.resumeAgentJob
      .updateMany({ where: { ...mineLease, status: "running" }, data: { leaseExpiresAt: new Date(now() + leaseMs) } })
      .then(({ count }) => {
        if (count === 0 && !controller.signal.aborted) controller.abort(new LostOwnershipError());
      })
      .catch(() => undefined);
  }, deps.heartbeatMs ?? HEARTBEAT_MS);

  const provider: ProviderId = job.provider && isProviderId(job.provider) ? job.provider : "anthropic";
  const llm = (deps.createClient ?? createLlmClient)(provider, { userId: job.userId, referenceId: job.id });
  const input = parsedInput.data;
  let stepsRun = 0;
  let outOfTime = false;
  let finished = false;
  try {
    for (;;) {
      if (controller.signal.aborted) break;
      const rows = await prisma.resumeAgentStep.findMany({ where: { jobId: job.id } });
      const state = evaluateRun(rows, { maxRevisions: settings.maxRevisions, minFit: settings.minFit, panel: settings.panel });
      if (state.fail) {
        const row = rows.find((r) => r.key === state.fail);
        const code: AgentErrorCode = ((row?.summary as { errorCode?: AgentErrorCode } | null)?.errorCode ?? null) || "step_failed";
        await failJob(job, code, row?.error ?? "단계를 끝내지 못했습니다. 다시 시도해 주세요.", state.fail, now());
        finished = true;
        break;
      }
      if (!state.next) {
        finished = true;
        break;
      }
      const next = state.next;
      const remaining = deadlineAt - now();
      const mult = provider === "anthropic" ? 1 : 1.5;
      const need = STEP_ESTIMATE_SEC[next.kind] * 1000 * mult + STEP_MARGIN_MS;
      if ((stepsRun > 0 && remaining < need) || remaining < 30_000 || (deps.maxStepsPerCall !== undefined && stepsRun >= deps.maxStepsPerCall)) {
        outOfTime = true;
        break;
      }
      if (stepsRun === 0) {
        // 호출 수는 실제로 단계를 시작할 때만 센다(빈 kick 반복으로 상한을 소진하지 못하게).
        const [bumped] = await prisma.resumeAgentJob.updateManyAndReturn({ where: mineLease, data: { continuations: { increment: 1 } } });
        if (!bumped) break;
        if (bumped.continuations > MAX_CONTINUATIONS) {
          await failJob(job, "continuations", CONTINUATIONS_ERROR, next.key, now());
          finished = true;
          break;
        }
      }
      stepsRun++;
      const existing = rows.find((r) => r.key === next.key);
      // 'running'으로 남은 행 = 이전 시도가 중간에 끊겼다(강제 종료·메모리 초과·중단 신호를 무시한 호출). catch를 거치지 않았으니
      // 여기서 시도 수를 센다: 상한이면 실패로 닫고(evaluateRun이 작업 실패·review_failed·건너뛰기로 처리), 아니면 잃은 토큰을 추정치로 더한다.
      const interrupted = existing?.status === "running";
      const priorUsage = addUsage(
        (existing?.usage as UsageTotals | null) ?? ZERO_USAGE,
        interrupted ? { ...ZERO_USAGE, inputTokens: STEP_TOKEN_ESTIMATE[next.kind] } : null,
      );
      if (existing && interrupted && existing.attempt >= MAX_STEP_ATTEMPTS) {
        const { count } = await prisma.resumeAgentStep.updateMany({
          where: { id: existing.id, status: "running", job: { is: { leaseId, runId: job.runId } } },
          data: {
            status: "failed",
            error: INTERRUPTED_ERROR,
            summary: { errorCode: "step_failed" } as Prisma.InputJsonValue,
            usage: priorUsage as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(now()),
          },
        });
        if (count === 0) break;
        // finalize가 이력서를 만든 뒤 끊겼으면 그 이력서도 지운다(작업은 실패로 닫힌다).
        const pending = next.kind === "finalize" ? PendingResumeSchema.safeParse(existing.output) : null;
        if (pending?.success) await discardResume(job.userId, pending.data.pendingResumeId);
        continue;
      }
      const attempt = (existing?.attempt ?? 0) + 1;
      if (existing) {
        await prisma.resumeAgentStep.update({
          where: { id: existing.id },
          data: { status: "running", attempt, startedAt: new Date(now()), finishedAt: null, ...(interrupted ? { usage: priorUsage as unknown as Prisma.InputJsonValue } : {}) },
        });
      } else {
        await prisma.resumeAgentStep.create({
          data: { id: nanoid(16), jobId: job.id, key: next.key, kind: next.kind, round: Math.max(0, next.round), status: "running", attempt, startedAt: new Date(now()) },
        });
      }
      await prisma.resumeAgentJob.updateMany({ where: mineLease, data: { currentStep: next.key, round: Math.max(0, next.round), updatedAt: new Date(now()) } });
      await deps.onStepStart?.(next.key);

      const fullCapMs = STEP_CAP_SEC[next.kind] * 1000 * mult;
      const capMs = Math.max(5_000, Math.min(fullCapMs, deadlineAt - now() - STEP_MARGIN_MS));
      // 호출 마감 때문에 상한이 줄었는가(이때의 시간 초과는 단계 탓이 아니다 — 시도로 세지 않고 새 호출로 넘긴다).
      const clamped = capMs < fullCapMs;
      const timeout = (deps.timeoutSignal ?? AbortSignal.timeout)(capMs);
      const signal = AbortSignal.any([controller.signal, timeout]);
      const ctx: StepContext = {
        job: { id: job.id, userId: job.userId, input },
        rows,
        llm,
        signal,
        settings,
        loadGraph: deps.loadGraph ?? loadAgentGraph,
        nowYear: deps.nowYear,
        previousOutput: existing?.output ?? null,
      };
      try {
        if (next.kind === "finalize") {
          const outcome = await finalizeJob(job, leaseId, rows, settings, ctx, existing ?? null, now, deps);
          if (outcome === "lost") break;
          finished = true;
          break;
        }
        const result = await runStep(next.kind, next.round, ctx);
        const output = STEP_OUTPUT_SCHEMAS[next.kind].parse(result.output);
        const { count } = await prisma.resumeAgentStep.updateMany({
          where: { jobId: job.id, key: next.key, status: { not: "done" }, job: { is: { leaseId, runId: job.runId } } },
          data: {
            status: "done",
            output: stripNulDeep(output) as Prisma.InputJsonValue,
            summary: stripNulDeep(result.summary.slice(0, 8)) as Prisma.InputJsonValue,
            usage: addUsage(priorUsage, result.usage) as unknown as Prisma.InputJsonValue,
            model: result.model,
            error: null,
            finishedAt: new Date(now()),
          },
        });
        if (count === 0) break; // 리스를 잃었다(취소·다시 시도·다른 호출).
        await saveProgress(job, leaseId, settings, result.usage, now());
      } catch (err) {
        if (controller.signal.aborted && controller.signal.reason instanceof LostOwnershipError) break;
        if (err instanceof LostOwnershipError) break;
        const used = err instanceof AgentStepError ? (err.usage ?? null) : usageOfError(err);
        const partial = err instanceof AgentStepError && err.partial !== undefined ? (stripNulDeep(err.partial) as Prisma.InputJsonValue) : undefined;
        if (clamped && timeout.aborted && !controller.signal.aborted) {
          // 호출 마감으로 줄어든 상한에서 시간이 다 됐다: 시도로 세지 않고 대기로 돌려 새 호출(온전한 상한)에서 다시 한다.
          const { count } = await prisma.resumeAgentStep.updateMany({
            where: { jobId: job.id, key: next.key, status: { not: "done" }, job: { is: { leaseId, runId: job.runId } } },
            data: {
              status: "pending",
              attempt: existing?.attempt ?? 0,
              error: null,
              ...(partial !== undefined ? { output: partial } : {}),
              usage: addUsage(priorUsage, used) as unknown as Prisma.InputJsonValue,
              finishedAt: new Date(now()),
            },
          });
          if (count === 0) break;
          if (used) await saveProgress(job, leaseId, settings, used, now());
          outOfTime = true;
          break;
        }
        const permanent = isPermanent(err);
        const exhausted = permanent || attempt >= MAX_STEP_ATTEMPTS;
        const message = agentStepErrorMessage(err);
        if (!(err instanceof AgentStepError) && !(err instanceof LlmPermanentError) && !(err instanceof FeatureError)) {
          console.error("[resume agent] 단계 실패", job.id, next.key, (err as Error)?.name ?? "error");
        }
        const { count } = await prisma.resumeAgentStep.updateMany({
          where: { jobId: job.id, key: next.key, status: { not: "done" }, job: { is: { leaseId, runId: job.runId } } },
          data: {
            status: exhausted ? "failed" : "pending",
            error: stripNul(message),
            ...(partial !== undefined ? { output: partial } : {}),
            ...(exhausted ? { summary: { errorCode: errorCodeOf(err) } as Prisma.InputJsonValue } : {}),
            usage: addUsage(priorUsage, used) as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(now()),
          },
        });
        if (count === 0) break;
        if (used) await saveProgress(job, leaseId, settings, used, now());
      }
    }
  } catch (err) {
    console.error("[resume agent] 실행 실패", job.id, (err as Error)?.name ?? "error");
  } finally {
    clearInterval(heartbeat);
  }
  if (finished) return;
  // 리스를 놓고 대기로 둔다(내 리스일 때만). 내 리스를 놓았고 작업이 안 끝났으면 다음 호출을 연다 — 시간 부족만이 아니라
  // 단계 뒤 진행 저장 실패·DB 오류로 멈춘 경우도(사용자가 화면을 닫아도 이어 가게). 리스를 잃었으면(count 0) 잇지 않는다.
  // 단계를 하나도 시작하지 못한 호출(호출 수를 세기 전 DB 오류)은 시간 부족일 때만 잇는다 — 오류가 계속되면 끝없이 이어지지 않게.
  const { count } = await prisma.resumeAgentJob
    .updateMany({ where: { ...mineLease, status: "running" }, data: { status: "waiting", leaseId: null, leaseExpiresAt: null, updatedAt: new Date(now()) } })
    .catch(() => ({ count: 0 }));
  if (count > 0 && (outOfTime || stepsRun > 0)) {
    const delay = deps.chainDelayMs ?? CHAIN_DELAY_AFTER_ERROR_MS;
    if (!outOfTime && delay > 0 && (deps.chain || chainEnabled())) await new Promise((r) => setTimeout(r, delay));
    const res = await (deps.chain ?? ((j) => requestChain(j)))({ id: job.id, runId: job.runId });
    if (!res.ok) await prisma.resumeAgentJob.updateMany({ where: { id: job.id, runId: job.runId }, data: { chainError: res.error.slice(0, 200) } }).catch(() => undefined);
  }
}

async function saveProgress(job: JobRow, leaseId: string, settings: AgentSettings, used: UsageTotals, now: number): Promise<void> {
  const [rows, fresh] = await Promise.all([
    prisma.resumeAgentStep.findMany({ where: { jobId: job.id } }),
    prisma.resumeAgentJob.findFirst({ select: { progress: true, usage: true }, where: { id: job.id, leaseId } }),
  ]);
  if (!fresh) return;
  const progress = progressFrom(rows, settings, (fresh.progress ?? {}) as Progress);
  await prisma.resumeAgentJob.updateMany({
    where: { id: job.id, runId: job.runId, leaseId },
    data: {
      progress: stripNulDeep(progress) as unknown as Prisma.InputJsonValue,
      usage: addUsage((fresh.usage as UsageTotals | null) ?? ZERO_USAGE, used) as unknown as Prisma.InputJsonValue,
      graphFingerprint: parsedOutput(rows, "retrieve", 0)?.pack.graphFingerprint ?? undefined,
      updatedAt: new Date(now),
    },
  });
}

/**
 * finalize(고아 이력서 없이):
 *   1) 리포트·문서를 먼저 만든다(실패하면 이력서를 만들기 전에 던진다).
 *   2) 이전 시도가 적어 둔 이력서 id(pendingResumeId)가 있으면 지운다 — 만든 뒤 완료 기록 전에 끊긴 시도의 잔여물.
 *   3) 새 id를 리스 조건으로 단계 행에 적고 나서 그 id로 이력서를 만든다(만들고 나서 끊겨도 다음 시도가 2)에서 회수).
 *   4) 완료 기록(소유 확인 트랜잭션). 던지거나 소유를 잃었으면 만든 이력서를 지운다.
 * 반환: 'done'(완료) | 'lost'(리스를 잃음 — 이력서는 지웠다). 그 밖의 실패는 던진다(호출자 catch가 시도로 센다).
 */
async function finalizeJob(
  job: JobRow,
  leaseId: string,
  rows: readonly StepRow[],
  settings: AgentSettings,
  ctx: StepContext,
  existing: StepRow | null,
  now: () => number,
  deps: AdvanceDeps,
): Promise<"done" | "lost"> {
  const user = await prisma.user.findUnique({ select: { name: true, email: true }, where: { id: job.userId } });
  const plan = await prepareFinalize(ctx, { name: user?.name ?? null, email: user?.email ?? null }, new Date(now()));
  const { createResume, newResumeId } = await import("@/lib/resumes/service");
  const pending = PendingResumeSchema.safeParse(existing?.output);
  if (pending.success) await discardResume(job.userId, pending.data.pendingResumeId);
  const resumeId = newResumeId();
  const { count } = await prisma.resumeAgentStep.updateMany({
    where: { jobId: job.id, key: "finalize", status: { not: "done" }, job: { is: { leaseId, runId: job.runId } } },
    data: { output: { pendingResumeId: resumeId } as Prisma.InputJsonValue },
  });
  if (count === 0) return "lost";
  await createResume(job.userId, { ...plan.create, id: resumeId });
  try {
    await deps.onResumeCreated?.(resumeId);
    const done = await completeJob(job, leaseId, rows, settings, resumeId, plan.report, plan.missingInfo, now());
    if (!done) {
      await discardResume(job.userId, resumeId);
      return "lost";
    }
    return "done";
  } catch (err) {
    await discardResume(job.userId, resumeId);
    throw err;
  }
}

/** finalize: 소유(run·리스) 확인 update가 1행일 때만 완료·알림. 아니면 false(호출자가 만든 이력서를 지운다). */
async function completeJob(
  job: JobRow,
  leaseId: string,
  rows: readonly StepRow[],
  settings: AgentSettings,
  resumeId: string,
  report: AgentReport,
  missingInfo: string[],
  now: number,
): Promise<boolean> {
  const progress = { ...progressFrom(rows, settings, (job.progress ?? {}) as Progress), stopReason: report.stopReason };
  const done = await prisma.$transaction(async (tx) => {
    const { count } = await tx.resumeAgentJob.updateMany({
      where: { id: job.id, runId: job.runId, leaseId, status: "running" },
      data: {
        status: "completed",
        currentStep: "finalize",
        resumeId,
        report: stripNulDeep(report) as unknown as Prisma.InputJsonValue,
        progress: stripNulDeep(progress) as unknown as Prisma.InputJsonValue,
        input: Prisma.DbNull,
        error: null,
        leaseId: null,
        leaseExpiresAt: null,
        completedAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
    if (count === 0) return false;
    const existing = rows.find((r) => r.key === "finalize");
    const data = { status: "done", output: { resumeId, stopReason: report.stopReason } as Prisma.InputJsonValue, summary: [`이력서 저장 · 채울 정보 ${missingInfo.length}개`] as Prisma.InputJsonValue, finishedAt: new Date(now) };
    if (existing) await tx.resumeAgentStep.update({ where: { id: existing.id }, data });
    else await tx.resumeAgentStep.updateMany({ where: { jobId: job.id, key: "finalize" }, data });
    return true;
  });
  if (!done) return false;
  const final = report.finalPanel ? ` · 심사 ${report.finalPanel.passCount}/7 통과` : "";
  const fit = report.rounds.find((r) => r.round === report.chosenRound)?.matchScore;
  await notify(job.userId, {
    kind: "resume-agent-completed",
    title: "AI 에이전트 이력서가 완성됐습니다",
    body: `${job.label}${final}${fit !== undefined ? ` · 적합도 ${fit}` : ""} · 채울 정보 ${report.gaps.length}개`,
    link: `/app/resumes/${resumeId}?report=1`,
  });
  return true;
}

// ---------------------------------------------------------------------------
// 조회·멈춤 판정
// ---------------------------------------------------------------------------

/** 리스 만료 회수(running → waiting)와 24시간 멈춤 실패. 바뀌었으면 새 행. */
async function settleStale(row: JobRow, now: number): Promise<JobRow> {
  if (row.status === "running" && row.leaseExpiresAt && row.leaseExpiresAt.getTime() < now) {
    const [next] = await prisma.resumeAgentJob.updateManyAndReturn({
      where: { id: row.id, runId: row.runId, status: "running", leaseId: row.leaseId, leaseExpiresAt: { lt: new Date(now) } },
      data: { status: "waiting", leaseId: null, leaseExpiresAt: null },
    });
    if (next) row = next;
  }
  if (row.status === "waiting" && now - row.updatedAt.getTime() > AGENT_IDLE_FAIL_MS) {
    if (await failJob(row, "idle", IDLE_ERROR, row.currentStep, now)) {
      return (await prisma.resumeAgentJob.findFirst({ where: { id: row.id } })) ?? row;
    }
  }
  return row;
}

/** 내 에이전트 작업(멈춤 판정 포함). 남의 것이면 null. */
export async function getAgentJob(userId: string, jobId: string, now: number = Date.now()): Promise<ResumeAgentJobView | null> {
  let row = await prisma.resumeAgentJob.findFirst({ where: { id: jobId, userId } });
  if (!row) return null;
  row = await settleStale(row, now);
  const steps = await prisma.resumeAgentStep.findMany({ where: { jobId: row.id } });
  return toAgentJobView(row, steps, now);
}

/** 이력서 편집 화면의 심사 리포트(완료된 작업 중 최근 것). 리포트 화면은 서버 컴포넌트가 이것을 직접 읽는다. */
export async function getAgentReportForResume(userId: string, resumeId: string): Promise<{ jobId: string; report: AgentReport } | null> {
  const row = await prisma.resumeAgentJob.findFirst({
    select: { id: true, report: true },
    where: { resumeId, userId, status: "completed" },
    orderBy: { completedAt: "desc" },
  });
  if (!row?.report) return null;
  const { AgentReportSchema } = await import("./schemas");
  const parsed = AgentReportSchema.safeParse(row.report);
  return parsed.success ? { jobId: row.id, report: parsed.data } : null;
}

/** 알림 sweep·목록 렌더: 리스 만료 회수, 24시간 멈춤 실패, 오래 기다린 waiting 작업에 이어 가기 요청(서명 fetch만 — 단계는 실행하지 않는다). */
export async function sweepStaleAgentJobs(userId: string, now: number = Date.now(), deps: { chain?: AdvanceDeps["chain"] } = {}): Promise<number> {
  const rows = await prisma.resumeAgentJob.findMany({ where: { userId, status: { in: [...ACTIVE] } }, take: 5 });
  let kicked = 0;
  for (const r of rows) {
    const row = await settleStale(r, now);
    if (row.status === "waiting" && row.leaseId === null && now - row.updatedAt.getTime() > IDLE_KICK_MS && chainEnabled()) {
      const res = await (deps.chain ?? ((j) => requestChain(j)))({ id: row.id, runId: row.runId });
      if (res.ok) kicked++;
      else await prisma.resumeAgentJob.updateMany({ where: { id: row.id, runId: row.runId }, data: { chainError: res.error.slice(0, 200) } }).catch(() => undefined);
    }
  }
  return kicked;
}

/** 이력서 목록 띠: 진행 중 + 최근 하루 안에 실패한 에이전트 작업(초안 작업 뷰 형식, href는 에이전트 진행 화면). */
export async function listVisibleAgentJobs(userId: string, now: number = Date.now()): Promise<ResumeDraftJobView[]> {
  const rows = await prisma.resumeAgentJob.findMany({
    where: { userId, OR: [{ status: { in: [...ACTIVE] } }, { status: "failed", input: { not: Prisma.DbNull }, updatedAt: { gt: new Date(now - FAILED_JOB_LIST_MS) } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 5,
  });
  const out: ResumeDraftJobView[] = [];
  for (const r of rows) {
    const row = await settleStale(r, now);
    const failed = row.status === "failed";
    const kind = parseStepKey(row.currentStep);
    out.push({
      id: row.id,
      status: failed ? "failed" : row.status === "completed" ? "completed" : "running",
      stage: "writing",
      label: row.label,
      error: row.error,
      resumeId: row.resumeId,
      notes: [],
      missingInfo: [],
      canRetry: failed && row.input !== null,
      attempts: row.attempts,
      startedAt: row.startedAt.getTime(),
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      completedAt: row.completedAt?.getTime() ?? null,
      mode: "agent",
      href: `/app/resumes/agent/${row.id}`,
      stageLabel: kind ? (kind.kind === "review" || kind.kind === "revise" ? stepTitle(kind.kind, kind.round) : AGENT_STEP_LABELS[kind.kind].label) : "진행 중",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 다시 시도·취소
// ---------------------------------------------------------------------------

/**
 * 다시 시도: 실패한 작업을 새 runId로 — 끝난 단계는 건너뛰고 실패한 단계부터(실패 단계 행만 pending·attempt 0).
 * from=jd면 처음부터(단계 행을 모두 지운다). 스키마 버전이 다르면 처음부터. beforeRestart(레이트 리밋)는 상태 확인 뒤.
 */
export async function retryAgentJob(
  userId: string,
  jobId: string,
  opts: { from?: "jd" | null; now?: () => number; beforeRestart?: () => Promise<void> } = {},
): Promise<{ job: ResumeAgentJobView; runId: string } | null> {
  const now = opts.now?.() ?? Date.now();
  const found = await prisma.resumeAgentJob.findFirst({ where: { id: jobId, userId } });
  if (!found) return null;
  const row = await settleStale(found, now);
  if (row.status === "completed") throw new FeatureError("이미 완성된 이력서입니다.", 409);
  if (row.status !== "failed" && row.status !== "canceled") throw new FeatureError("에이전트가 아직 진행 중입니다. 잠시 후 다시 확인해 주세요.", 409);
  if (!CreateResumeInputSchema.safeParse(row.input).success) throw new FeatureError(INPUT_ERROR, 409);
  if ((row.progress as Progress | null)?.errorCode === "insufficient_graph" && opts.from !== "jd") {
    throw new FeatureError("경험 그래프에 쓸 내용이 부족합니다. 그래프를 정리한 뒤 새로 만들거나 빠른 초안으로 만들어 주세요.", 409);
  }
  const busy = await activeAgentJob(userId, prisma, row.id);
  if (busy) throw new AgentBusyError(busy);
  await assertResumeSlots(userId, now);
  await opts.beforeRestart?.();
  const runId = nanoid();
  const fresh = opts.from === "jd" || row.schemaVersion !== AGENT_SCHEMA_VERSION;
  const updated = await prisma.$transaction(async (tx) => {
    await lockAgentJobs(tx, userId);
    if (await activeAgentJob(userId, tx, row.id)) throw new AgentBusyError((await activeAgentJob(userId, tx, row.id))!);
    const [next] = await tx.resumeAgentJob.updateManyAndReturn({
      where: { id: row.id, userId, runId: row.runId, status: row.status },
      data: {
        runId,
        status: "waiting",
        error: null,
        failedStep: null,
        leaseId: null,
        leaseExpiresAt: null,
        continuations: 0,
        attempts: { increment: 1 },
        schemaVersion: AGENT_SCHEMA_VERSION,
        progress: fresh ? Prisma.DbNull : ({ ...((row.progress ?? {}) as Progress), errorCode: null } as unknown as Prisma.InputJsonValue),
        startedAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
    if (!next) return null;
    if (fresh) await tx.resumeAgentStep.deleteMany({ where: { jobId: row.id } });
    else await tx.resumeAgentStep.updateMany({ where: { jobId: row.id, status: { in: ["failed", "running", "pending"] } }, data: { status: "pending", attempt: 0, error: null } });
    return next;
  });
  if (!updated) throw new FeatureError("다른 요청이 먼저 이 작업을 다시 시작했습니다. 새로고침해 주세요.", 409);
  const steps = await prisma.resumeAgentStep.findMany({ where: { jobId: row.id } });
  return { job: toAgentJobView(updated, steps, now), runId };
}

/** 같은 입력으로 빠른 초안(단일 초안 작업)을 만들 입력. 완성된 작업이면 409, 입력이 만료됐으면 409. 이 작업은 호출자가 시작 뒤 취소로 닫는다. */
export async function agentJobInputForFallback(userId: string, jobId: string): Promise<CreateResumeInput | null> {
  const row = await prisma.resumeAgentJob.findFirst({ where: { id: jobId, userId } });
  if (!row) return null;
  if (row.status === "completed") throw new FeatureError("이미 완성된 이력서입니다.", 409);
  const parsed = CreateResumeInputSchema.safeParse(row.input);
  if (!parsed.success) throw new FeatureError(INPUT_ERROR, 409);
  return parsed.data;
}

/** 빠른 초안으로 넘긴 작업을 닫는다(진행 중이면 리스도 놓는다). */
export async function closeForFallback(userId: string, jobId: string, now: number = Date.now()): Promise<void> {
  await prisma.resumeAgentJob.updateMany({
    where: { id: jobId, userId, status: { not: "completed" } },
    data: { status: "canceled", leaseId: null, leaseExpiresAt: null, updatedAt: new Date(now) },
  });
}

export async function cancelAgentJob(userId: string, jobId: string, now: number = Date.now()): Promise<ResumeAgentJobView | null> {
  const row = await prisma.resumeAgentJob.findFirst({ where: { id: jobId, userId } });
  if (!row) return null;
  if (row.status === "completed") throw new FeatureError("이미 완성됐습니다.", 409);
  if (row.status === "running" || row.status === "waiting") {
    await prisma.resumeAgentJob.updateMany({
      where: { id: row.id, userId, status: { in: [...ACTIVE] } },
      data: { status: "canceled", leaseId: null, leaseExpiresAt: null, updatedAt: new Date(now) },
    });
  }
  return getAgentJob(userId, jobId, now);
}

/** 이 작업을 지금 이어 가도 되는가(사용자 advance 라우트). 진행 중 리스가 살아 있으면 false(no-op). */
export async function canAdvance(userId: string, jobId: string, now: number = Date.now()): Promise<"ok" | "busy" | "missing" | "done"> {
  const row = await prisma.resumeAgentJob.findFirst({ select: { status: true, leaseId: true, leaseExpiresAt: true }, where: { id: jobId, userId } });
  if (!row) return "missing";
  if (row.status !== "running" && row.status !== "waiting") return "done";
  if (row.leaseId && row.leaseExpiresAt && row.leaseExpiresAt.getTime() >= now) return "busy";
  return "ok";
}
