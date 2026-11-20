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
 * - 다음 단계는 저장된 단계 행만으로 계산한다(v1 next-step.ts evaluateRun, v2 next-step-v2.ts evaluateSectionRun — 작업의 pipeline_version으로 고른다).
 *   v2는 같은 웨이브·라운드의 구역 단계를 한 리스 안에서 병렬로 실행하고(배치), 구역 행마다 따로 done·failed를 쓴다.
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
import {
  applyRegeneratedMeta,
  assertRegenerateSlot,
  discardRegeneratedVersion,
  REGENERATE_TARGET_GONE,
  regeneratedResumeHref,
  saveRegeneratedVersion,
} from "@/lib/resumes/regenerate";
import { CreateResumeInputSchema, type CreateResumeInput } from "@/lib/resumes/types";
import { agentEnabledFor, agentSettings, type AgentSettings } from "./config";
import { chainEnabled, isAgentRunner, requestChain, type ChainResult } from "./chain";
import { hasAgentGraphMaterial, loadAgentGraph } from "./evidence";
import { graphEvidenceSource, type EvidenceSource } from "./evidence-source";
import { findReusableJdAnalysis } from "./jd-source";
import {
  AGENT_STEP_LABELS,
  parseStepKey,
  SECTION_IDS,
  SECTION_LABELS,
  sectionStepKey,
  stepTitle,
  type AgentErrorCode,
  type AgentStepView,
  type FinalPanelView,
  type OrchestratorFeedbackView,
  type ResumeAgentJobStatus,
  type ResumeAgentJobView,
  type RoundScoreView,
  type SectionCardView,
  type SectionId,
} from "./job-types";
import { parsedOutput, STEP_CAP_SEC, STEP_ESTIMATE_SEC, STEP_OUTPUT_SCHEMAS, STEP_TOKEN_ESTIMATE, type NextStep, type StepRowLike } from "./next-step";
import { critiqueOf, currentPackV2, isFallbackAttempt, isMotivationSection, isWave2, maxAttemptsFor, SECTION_CAP_SEC, SECTION_ESTIMATE_SEC, SECTION_TOKEN_ESTIMATE } from "./next-step-v2";
import { evaluateAny, pipelineOf, previewAt, type PipelineVersion } from "./pipeline";
import { AGENT_SCHEMA_VERSION, SectionStepOutputSchema, type AgentReport } from "./schemas";
import { humanizeRefs } from "./sections/common";
import { runBriefStep } from "./steps/brief";
import { runComposeStep } from "./steps/compose";
import { runCritiqueStep } from "./steps/critique";
import { prepareFinalize } from "./steps/finalize";
import { runJdStep, runJdStepV2, type FindJd } from "./steps/jd";
import { runPlanStep } from "./steps/plan";
import { runSectionStep } from "./steps/section";
import { runRetrieveStep } from "./steps/retrieve";
import { runFinalPanelStep, runReviewStep } from "./steps/review";
import { runReviseStep } from "./steps/revise";
import { addUsage, AgentStepError, ZERO_USAGE, type StepContext, type StepResult } from "./steps/shared";
import type { MotivationSuggestResponse } from "@/lib/domain/resume-motivation";
import { runWriteBodyStep, runWriteTopStep } from "./steps/write";

/** 에이전트 라우트(시작·이어 가기·다시 시도·내부 연쇄)의 maxDuration과 같아야 한다(라우트는 리터럴로 적는다). */
export const AGENT_ROUTE_MAX_DURATION_SEC = 300;
/** 자체 호스팅(플랫폼 시간 제한 없음)의 한 호출 예산. */
export const SELF_HOSTED_AGENT_TIME_LIMIT_MS = 20 * 60_000;
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
/** 동시에 진행할 수 있는 에이전트 작업 수(사용자당, running·waiting — 새로 만들기·다시 생성·다시 시도를 함께 센다). */
export const MAX_ACTIVE_AGENT_JOBS = 3;
export const MAX_CONTINUATIONS = 20;
/** v2는 순서 배치가 약 17~20개(웨이브·라운드·재작성 웨이브)라 상한을 따로 둔다. */
export const MAX_CONTINUATIONS_V2 = 36;
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
/** 다시 생성의 finalize 단계 행 output: 저장 직전에 적어 둔 버전 id(완료 기록 전에 끊기면 다음 시도가 지운다 — 버전이 둘 생기지 않게). */
const PendingVersionSchema = z.object({ pendingVersionId: z.string().min(1).max(40) });

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
    super(`에이전트 작성은 동시에 ${MAX_ACTIVE_AGENT_JOBS}개까지 진행할 수 있습니다. 진행 중인 작업이 끝난 뒤 다시 시작하거나 진행 화면에서 확인해 주세요.`, 409);
    this.name = "AgentBusyError";
  }
}

// ---------------------------------------------------------------------------
// 뷰
// ---------------------------------------------------------------------------

const STEP_ORDER = ["r0.jd", "r0.retrieve", "r0.plan", "r0.write_body", "r0.write_top", "r0.review", "r1.revise", "r1.review", "r2.revise", "r2.review", "final_panel", "finalize"];

interface Progress {
  /** v2: 시작 때 고정한 계획 설정(이어 가기·재배포 뒤 환경 변수가 바뀌어도 같은 계획). */
  pinned?: PinnedSettings;
  coverage?: ResumeAgentJobView["coverage"];
  rounds?: RoundScoreView[];
  finalPanel?: FinalPanelView | null;
  stopReason?: ResumeAgentJobView["stopReason"];
  previewText?: string | null;
  errorCode?: AgentErrorCode | null;
}

/** v2가 시작 때 고정하는 설정(단계 계획을 바꾸는 값). */
type PinnedSettings = Pick<AgentSettings, "parallel" | "motivation" | "maxRevisions">;

function pinnedOf(settings: AgentSettings): PinnedSettings {
  return { parallel: settings.parallel, motivation: settings.motivation, maxRevisions: settings.maxRevisions };
}

/** 작업 행에 고정한 설정을 덮어쓴다(값이 이상하면 무시). */
export function applyPinnedSettings(settings: AgentSettings, progress: unknown): AgentSettings {
  const p = (progress as Progress | null)?.pinned;
  if (!p || typeof p !== "object") return settings;
  return {
    ...settings,
    ...(Number.isInteger(p.parallel) && p.parallel >= 1 && p.parallel <= 4 ? { parallel: p.parallel } : {}),
    ...(typeof p.motivation === "boolean" ? { motivation: p.motivation } : {}),
    ...(Number.isInteger(p.maxRevisions) && p.maxRevisions >= 0 && p.maxRevisions <= 2 ? { maxRevisions: p.maxRevisions } : {}),
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : []);

/** v2 총괄 타임라인(구역 단계는 라운드마다 묶음 하나 'r{k}.sections' + 아래 구역 카드). */
const STEP_ORDER_V2 = ["r0.jd", "r0.retrieve", "r0.brief", "r0.sections", "r0.compose", "r0.review", "r0.critique", "r1.sections", "r1.compose", "r1.review", "r1.critique", "r2.sections", "r2.compose", "r2.review", "final_panel", "finalize"];

const SECTION_STATUS_TEXT: Record<string, string> = { pending: "대기", running: "작성 중", done: "완료", failed: "실패", skipped: "건너뜀" };

function stepViewsV2(rows: readonly StepRow[]): AgentStepView[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const views: AgentStepView[] = [];
  for (const key of STEP_ORDER_V2) {
    const group = /^r(\d)\.sections$/.exec(key);
    if (group) {
      const k = Number(group[1]);
      const secRows = rows.filter((r) => r.key.startsWith(`r${k}.sec.`));
      if (secRows.length === 0 && k >= 1) continue;
      const status: AgentStepView["status"] =
        secRows.length === 0
          ? "pending"
          : secRows.some((r) => r.status === "running")
            ? "running"
            : secRows.every((r) => r.status === "done" || r.status === "failed" || r.status === "skipped") && (k >= 1 || byKey.has("r0.compose") || secRows.length >= 5)
              ? "done"
              : "pending";
      const summary = secRows
        .map((r) => {
          const p = parseStepKey(r.key);
          return p?.section ? `${SECTION_LABELS[p.section]} ${SECTION_STATUS_TEXT[r.status] ?? r.status}` : "";
        })
        .filter(Boolean);
      views.push({ key, kind: "section", round: k, status, summary: [summary.join(" · ")].filter(Boolean), error: null, startedAt: null, finishedAt: null });
      continue;
    }
    const row = byKey.get(key);
    const parsed = parseStepKey(key)!;
    if (!row && (parsed.round >= 1 || key === "r0.critique")) continue;
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

/** v2 구역 카드: 라운드별 칩(대기·작성 중·완료·유지·실패→이전 결과 사용). 근거 텍스트·노드 id는 담지 않는다. */
function sectionCards(rows: readonly StepRow[]): SectionCardView[] {
  const composed = rows.some((r) => r.key === "r0.compose");
  return SECTION_IDS.map((section: SectionId) => {
    const rounds: SectionCardView["rounds"] = [];
    for (let k = 0; k <= 2; k++) {
      const row = rows.find((r) => r.key === sectionStepKey(section, k));
      const score = critiqueOf(rows, k)?.sectionScores.find((x) => x.section === section)?.score ?? null;
      if (row) {
        const out = row.status === "done" ? SectionStepOutputSchema.safeParse(row.output) : null;
        rounds.push({ round: k, status: row.status as AgentStepView["status"], summary: strings(row.summary).slice(0, 3), score, fallback: row.status === "failed" || (out?.success ? out.data.fallback !== null : false) });
      } else if (k === 0 && !isMotivationSection(section)) {
        rounds.push({ round: 0, status: "pending", summary: [], score, fallback: false });
      } else if (k >= 1 && !isMotivationSection(section) && critiqueOf(rows, k - 1)) {
        rounds.push({ round: k, status: "kept", summary: ["총괄이 그대로 두기로 했습니다"], score, fallback: false });
      }
    }
    const skipped = isMotivationSection(section) && composed && !rows.some((r) => r.key === sectionStepKey(section, 0));
    if (isMotivationSection(section) && rounds.length === 0 && !skipped) rounds.push({ round: 0, status: "pending", summary: [], score: null, fallback: false });
    return { section, label: SECTION_LABELS[section], rounds, skipped };
  });
}

/** v2 총괄 피드백 기록(근거 ref는 근거 이름으로). */
function orchestratorViews(rows: readonly StepRow[]): OrchestratorFeedbackView[] {
  const pack = currentPackV2(rows);
  return [0, 1].flatMap((k) => {
    const c = critiqueOf(rows, k);
    if (!c) return [];
    const feedback: OrchestratorFeedbackView["feedback"] = c.feedback.map((f) => ({ section: f.section, label: SECTION_LABELS[f.section], instructions: f.instructions.map((x) => humanizeRefs(x, pack)).filter(Boolean).slice(0, 5) }));
    if (c.composeFeedback.length) feedback.push({ section: "compose", label: "요약·상단", instructions: c.composeFeedback.map((x) => humanizeRefs(x, pack)).slice(0, 5) });
    return [{ round: k, summary: humanizeRefs(c.summary, pack), feedback }];
  });
}

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
  const v2 = pipelineOf(job.pipelineVersion) === 2;
  return {
    id: job.id,
    mode: "agent",
    pipelineVersion: v2 ? 2 : 1,
    ...(v2 ? { sections: sectionCards(rows), orchestrator: orchestratorViews(rows) } : {}),
    status,
    label: job.label,
    currentStep: job.currentStep,
    steps: v2 ? stepViewsV2(rows) : stepViews(rows),
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
    ...(job.targetResumeId ? { regenerate: true, targetResumeId: job.targetResumeId } : {}),
  };
}

/** 단계 행 → 진행 화면 요약(라운드 점수·커버리지·최선 초안 미리 보기). 근거 텍스트·노드 id는 담지 않는다. */
function progressFrom(rows: readonly StepRowLike[], settings: AgentSettings, prev: Progress, version: PipelineVersion = 1, company = false): Progress {
  const state = evaluateAny(rows, { version, settings, company });
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
  if (best !== null) previewText = previewAt(rows, version, best) ?? previewText;
  else previewText = previewAt(rows, version, 0) ?? previewText;
  const final = parsedOutput(rows, "final_panel", -1);
  let finalPanel: FinalPanelView | null = null;
  const chosen = state.rounds.find((r) => r.round === best);
  if (final && chosen) {
    const verdicts = [...chosen.verdicts.map((v) => ({ ...v, verdict: v.verdict as string | null })), ...final.verdicts];
    finalPanel = { passCount: verdicts.filter((v) => v.positive).length, total: 7, verdicts };
  }
  // v2는 종료를 정한 뒤 저장 전에 지원 동기 초안을 다시 쓰는 배치가 올 수 있다(그때도 종료 사유를 보인다).
  const settled = state.next.length === 0 || state.next[0]!.kind === "final_panel" || state.next[0]!.kind === "finalize" || (version === 2 && state.stopReason !== null);
  return { ...prev, coverage: ret?.pack.coverage ?? prev.coverage ?? null, rounds, finalPanel, stopReason: settled ? state.stopReason : null, previewText };
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

async function lockAgentJobs(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`resume-agent:${userId}`}))`;
}

/** 동시 작업 상한(MAX_ACTIVE_AGENT_JOBS)에 닿았으면 진행 중인 작업 중 가장 최근 것의 id(409 안내 링크용), 자리가 있으면 null. */
async function busyAgentJob(userId: string, db: Prisma.TransactionClient = prisma, exceptId?: string): Promise<string | null> {
  const rows = await db.resumeAgentJob.findMany({
    select: { id: true },
    where: { userId, status: { in: [...ACTIVE] }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    orderBy: { createdAt: "desc" },
    take: MAX_ACTIVE_AGENT_JOBS,
  });
  return rows.length >= MAX_ACTIVE_AGENT_JOBS ? rows[0]!.id : null;
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
  /** 만들기 직전 확인(다른 확인 뒤에 부른다). 에이전트는 하루 한도가 없어 라우트는 넘기지 않는다. */
  beforeCreate?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  /** '다시 생성': 새 이력서 대신 이 이력서(호출자가 소유권을 확인한 id)의 새 버전을 저장한다. label은 작업 표시 이름. */
  regenerate?: { resumeId: string; label: string };
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
  const regen = deps.regenerate ?? null;
  const busy = await busyAgentJob(user.id);
  if (busy) throw new AgentBusyError(busy);
  // 다시 생성은 이력서 수를 늘리지 않는다(동시 작업 상한은 같이 센다).
  if (!regen) await assertResumeSlots(user.id, now);
  await deps.beforeCreate?.();
  await cleanupOldJobs(user.id, now);

  const runId = nanoid();
  const general = input.kind === "general";
  const stored: CreateResumeInput = { ...input, jdText: general ? "" : input.jdText.slice(0, AGENT_JD_MAX_CHARS), provider };
  const row = await prisma.$transaction(async (tx) => {
    // 잠금 순서: 이력서별 다시 생성 잠금 → 사용자별 에이전트 잠금(초안 작업과 같은 순서 — 서로 기다리다 막히지 않게).
    if (regen) await assertRegenerateSlot(tx, user.id, regen.resumeId, { now });
    await lockAgentJobs(tx, user.id);
    const again = await busyAgentJob(user.id, tx);
    if (again) throw new AgentBusyError(again);
    if (!regen) await assertResumeSlots(user.id, now, tx);
    return tx.resumeAgentJob.create({
      data: {
        id: nanoid(16),
        userId: user.id,
        runId,
        status: "waiting",
        currentStep: "r0.jd",
        label: stripNul(regen ? regen.label : draftJobLabel(input)),
        targetResumeId: regen?.resumeId ?? null,
        input: stripNulDeep(stored) as Prisma.InputJsonValue,
        provider,
        deploymentId: env.VERCEL_DEPLOYMENT_ID?.slice(0, 120) ?? null,
        schemaVersion: AGENT_SCHEMA_VERSION,
        // 단계 계획 버전은 시작 때 고정한다(다시 시도·이어 가기·재배포 뒤에도 바뀌지 않는다).
        pipelineVersion: agentSettings(env).pipeline,
        // v2 계획 설정(병렬·지원 동기·재작성 횟수)도 시작 때 고정한다.
        ...(agentSettings(env).pipeline === 2 ? { progress: { pinned: pinnedOf(agentSettings(env)) } as unknown as Prisma.InputJsonValue } : {}),
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
  /** v2 근거 검색(기본 graphEvidenceSource(loadGraph) — 작업 행 userId만). */
  evidence?: EvidenceSource;
  /** v2 저장된 JD 분석 찾기(기본 jd-source.ts). */
  findJd?: FindJd;
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

async function notifyAgentFailed(userId: string, jobId: string, label: string, error: string, regenerate = false): Promise<void> {
  await notify(userId, {
    kind: "resume-agent-failed",
    title: regenerate ? "AI 에이전트가 이력서를 다시 생성하지 못했습니다" : "AI 에이전트가 이력서를 끝내지 못했습니다",
    body: `${label} — ${error}`,
    link: `/app/resumes/agent/${jobId}`,
  });
}

/** 작업을 실패로 닫는다(실행 중 조건). 닫았으면 알림. */
async function failJob(job: Pick<JobRow, "id" | "userId" | "runId" | "label" | "progress" | "targetResumeId">, code: AgentErrorCode, message: string, failedStep: string | null, now: number): Promise<boolean> {
  const progress = { ...((job.progress ?? {}) as Progress), errorCode: code };
  const { count } = await prisma.resumeAgentJob.updateMany({
    where: { id: job.id, runId: job.runId, status: { in: [...ACTIVE] } },
    data: { status: "failed", error: stripNul(message), failedStep, leaseId: null, leaseExpiresAt: null, progress: progress as unknown as Prisma.InputJsonValue, updatedAt: new Date(now) },
  });
  if (count > 0) await notifyAgentFailed(job.userId, job.id, job.label, message, job.targetResumeId !== null);
  return count > 0;
}

async function runStep(next: NextStep, ctx: StepContext, deps: AdvanceDeps): Promise<StepResult> {
  const { kind, round } = next;
  switch (kind) {
    case "jd":
      return ctx.pipeline === 2 ? runJdStepV2(ctx, deps.findJd ?? findReusableJdAnalysis) : runJdStep(ctx);
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
    case "brief":
      return runBriefStep(ctx);
    case "section":
      if (!next.section) throw new Error("구역 단계에 구역 id가 없다");
      return runSectionStep(ctx, next.section, round);
    case "compose":
      return runComposeStep(ctx, round);
    case "critique":
      return runCritiqueStep(ctx, round);
    case "finalize":
      throw new Error("finalize는 따로 실행한다");
  }
}

/** 라운드 0 구역의 마지막 시도는 v1 작성기(write_body·write_top) 전체를 돌리므로 그 단계의 추정·상한을 쓴다. */
const fallbackKind = (n: NextStep, attempt: number): "write_body" | "write_top" | null =>
  isFallbackAttempt(n, attempt) ? (isWave2(n.section!) ? "write_top" : "write_body") : null;
const estimateSec = (n: NextStep, attempt = 1) => {
  const fb = fallbackKind(n, attempt);
  if (fb) return STEP_ESTIMATE_SEC[fb];
  return n.kind === "section" && n.section ? SECTION_ESTIMATE_SEC[n.section] : STEP_ESTIMATE_SEC[n.kind];
};
const capSec = (n: NextStep, attempt = 1) => {
  const fb = fallbackKind(n, attempt);
  if (fb) return STEP_CAP_SEC[fb];
  return n.kind === "section" && n.section ? SECTION_CAP_SEC[n.section] : STEP_CAP_SEC[n.kind];
};
/** 한 호출이 단계 하나에 줄 수 있는 최대 시간(Vercel 300 − 30 − 여유 = 255초, 자체 호스팅은 20분 − 여유). */
export const callMaxStepMs = (env: Record<string, string | undefined> = process.env) => agentDeadline(0, env) - STEP_MARGIN_MS;
/** 같은 호출 안 준비 시간(조회·리스 등) 허용치 — 첫 배치의 상한이 이만큼 덜 줄어든 것은 '호출 마감 탓'으로 보지 않는다. */
const CALL_SETUP_SLACK_MS = 10_000;

/**
 * 이번 상한(capMs)이 호출 마감 때문에 줄었는가 — 그때의 시간 초과는 시도로 세지 않고 새 호출로 넘긴다.
 * 비교 기준은 '새 호출이 줄 수 있는 시간'이다: 단계 상한(× 엔진 배수)이 한 호출보다 길면(예: Anthropic 밖 엔진의 경력 230 × 1.5초)
 * 새 호출의 첫 배치도 같은 시간밖에 못 주므로, 그때의 시간 초과는 시도로 센다(마지막 시도의 대체 경로로 넘어가게).
 */
export function capWasClamped(capMs: number, fullCapMs: number, callMaxMs: number = callMaxStepMs()): boolean {
  return capMs < Math.min(fullCapMs, callMaxMs - CALL_SETUP_SLACK_MS);
}
const tokenEstimate = (n: NextStep) => (n.kind === "section" && n.section ? SECTION_TOKEN_ESTIMATE[n.section] : STEP_TOKEN_ESTIMATE[n.kind]);

type StepOutcome = "ok" | "lost" | "out_of_time" | "finished";

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
  let settings = deps.settings ?? agentSettings();
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const deadlineAt = opts.deadlineAt ?? agentDeadline(now());
  let job = await prisma.resumeAgentJob.findFirst({
    where: { id: jobId, ...(opts.userId ? { userId: opts.userId } : {}), ...(opts.runId ? { runId: opts.runId } : {}), status: { in: [...ACTIVE] } },
  });
  if (!job) return;
  if (job.schemaVersion !== AGENT_SCHEMA_VERSION) {
    // 실행기 빌드가 앱 배포보다 오래됐으면(행이 더 새 버전) 건드리지 않는다 — 새 빌드(Vercel)가 실행한다. 실패로 닫지 않는다.
    if (isAgentRunner() && job.schemaVersion > AGENT_SCHEMA_VERSION) return;
    await failJob(job, "schema_version", SCHEMA_ERROR, job.currentStep, now());
    return;
  }
  const parsedInput = CreateResumeInputSchema.safeParse(job.input);
  if (!parsedInput.success) {
    await failJob(job, "input_missing", INPUT_ERROR, job.currentStep, now());
    return;
  }
  // 다시 생성 대상이 그사이 지워졌으면 단계를 더 돌리지 않고 실패로 닫는다.
  if (job.targetResumeId && !(await prisma.companyResume.findFirst({ select: { id: true }, where: { id: job.targetResumeId, userId: job.userId } }))) {
    await failJob(job, "step_failed", REGENERATE_TARGET_GONE, job.currentStep, now());
    return;
  }

  const leaseId = nanoid();
  const [claimed] = await prisma.resumeAgentJob.updateManyAndReturn({
    where: { id: job.id, runId: job.runId, status: { in: [...ACTIVE] }, OR: [{ leaseId: null }, { leaseExpiresAt: { lt: new Date(now()) } }] },
    data: { leaseId, leaseExpiresAt: new Date(now() + leaseMs), status: "running", updatedAt: new Date(now()) },
  });
  if (!claimed) return;
  job = claimed;
  if (pipelineOf(job.pipelineVersion) === 2) settings = applyPinnedSettings(settings, job.progress);
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
  const version = pipelineOf(job.pipelineVersion);
  const company = input.kind === "company";
  const evidence = deps.evidence ?? graphEvidenceSource(deps.loadGraph ?? loadAgentGraph);
  const mult = provider === "anthropic" ? 1 : 1.5;
  let stepsRun = 0;
  let outOfTime = false;
  let finished = false;
  // 병렬 구역 단계가 진행 요약·사용량을 같은 행에 쓰므로 진행 저장은 한 번에 하나씩(읽고-더하고-쓰기가 겹치지 않게).
  let saving: Promise<void> = Promise.resolve();
  const saveSerial = (used: UsageTotals): Promise<void> => {
    const p = saving.then(() => saveProgress(job!, leaseId, settings, used, now(), version, company));
    saving = p.catch(() => undefined);
    return p;
  };

  /** 단계 하나 실행(배치 안에서 병렬로 불린다). 던지면 호출자가 멈춘다. */
  const runOne = async (next: NextStep, rows: readonly StepRow[], memo: Map<string, Promise<unknown>>): Promise<StepOutcome> => {
    const jobRow = job!;
    const existing = rows.find((r) => r.key === next.key);
    // 'running'으로 남은 행 = 이전 시도가 중간에 끊겼다(강제 종료·메모리 초과·중단 신호를 무시한 호출). catch를 거치지 않았으니
    // 여기서 시도 수를 센다: 상한이면 실패로 닫고(다음 계산이 작업 실패·review_failed·건너뛰기·이전 결과 사용으로 처리), 아니면 잃은 토큰을 추정치로 더한다.
    const interrupted = existing?.status === "running";
    const priorUsage = addUsage((existing?.usage as UsageTotals | null) ?? ZERO_USAGE, interrupted ? { ...ZERO_USAGE, inputTokens: tokenEstimate(next) } : null);
    if (existing && interrupted && existing.attempt >= maxAttemptsFor(next)) {
      const { count } = await prisma.resumeAgentStep.updateMany({
        where: { id: existing.id, status: "running", job: { is: { leaseId, runId: jobRow.runId } } },
        data: {
          status: "failed",
          error: INTERRUPTED_ERROR,
          summary: { errorCode: "step_failed" } as Prisma.InputJsonValue,
          usage: priorUsage as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(now()),
        },
      });
      if (count === 0) return "lost";
      // finalize가 이력서(다시 생성은 버전)를 만든 뒤 끊겼으면 그것도 지운다(작업은 실패로 닫힌다).
      const pending = next.kind === "finalize" ? PendingResumeSchema.safeParse(existing.output) : null;
      if (pending?.success) await discardResume(jobRow.userId, pending.data.pendingResumeId);
      const pendingVersion = next.kind === "finalize" && jobRow.targetResumeId ? PendingVersionSchema.safeParse(existing.output) : null;
      if (pendingVersion?.success) await discardRegeneratedVersion(jobRow.userId, jobRow.targetResumeId!, pendingVersion.data.pendingVersionId);
      return "ok";
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    if (existing) {
      await prisma.resumeAgentStep.update({
        where: { id: existing.id },
        data: { status: "running", attempt, startedAt: new Date(now()), finishedAt: null, ...(interrupted ? { usage: priorUsage as unknown as Prisma.InputJsonValue } : {}) },
      });
    } else {
      await prisma.resumeAgentStep.create({
        data: { id: nanoid(16), jobId: jobRow.id, key: next.key, kind: next.kind, round: Math.max(0, next.round), section: next.section ?? null, status: "running", attempt, startedAt: new Date(now()) },
      });
    }
    await deps.onStepStart?.(next.key);

    const fullCapMs = capSec(next, attempt) * 1000 * mult;
    const capMs = Math.max(5_000, Math.min(fullCapMs, deadlineAt - now() - STEP_MARGIN_MS));
    // 호출 마감 때문에 상한이 줄었는가(이때의 시간 초과는 단계 탓이 아니다 — 시도로 세지 않고 새 호출로 넘긴다).
    const clamped = capWasClamped(capMs, fullCapMs);
    const timeout = (deps.timeoutSignal ?? AbortSignal.timeout)(capMs);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const ctx: StepContext = {
      job: { id: jobRow.id, userId: jobRow.userId, input },
      rows,
      llm,
      signal,
      settings,
      loadGraph: deps.loadGraph ?? loadAgentGraph,
      nowYear: deps.nowYear,
      previousOutput: existing?.output ?? null,
      pipeline: version,
      evidence,
      attempt,
      targetResumeId: jobRow.targetResumeId,
      memo,
    };
    try {
      if (next.kind === "finalize") {
        const outcome = await finalizeJob(jobRow, leaseId, rows, settings, ctx, existing ?? null, now, deps);
        return outcome === "lost" ? "lost" : "finished";
      }
      const result = await runStep(next, ctx, deps);
      const output = STEP_OUTPUT_SCHEMAS[next.kind].parse(result.output);
      const { count } = await prisma.resumeAgentStep.updateMany({
        where: { jobId: jobRow.id, key: next.key, status: { not: "done" }, job: { is: { leaseId, runId: jobRow.runId } } },
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
      if (count === 0) return "lost"; // 리스를 잃었다(취소·다시 시도·다른 호출).
      await saveSerial(result.usage);
      return "ok";
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof LostOwnershipError) return "lost";
      if (err instanceof LostOwnershipError) return "lost";
      const used = err instanceof AgentStepError ? (err.usage ?? null) : usageOfError(err);
      const partial = err instanceof AgentStepError && err.partial !== undefined ? (stripNulDeep(err.partial) as Prisma.InputJsonValue) : undefined;
      if (clamped && timeout.aborted && !controller.signal.aborted) {
        // 호출 마감으로 줄어든 상한에서 시간이 다 됐다: 시도로 세지 않고 대기로 돌려 새 호출(온전한 상한)에서 다시 한다.
        const { count } = await prisma.resumeAgentStep.updateMany({
          where: { jobId: jobRow.id, key: next.key, status: { not: "done" }, job: { is: { leaseId, runId: jobRow.runId } } },
          data: {
            status: "pending",
            attempt: existing?.attempt ?? 0,
            error: null,
            ...(partial !== undefined ? { output: partial } : {}),
            usage: addUsage(priorUsage, used) as unknown as Prisma.InputJsonValue,
            finishedAt: new Date(now()),
          },
        });
        if (count === 0) return "lost";
        if (used) await saveSerial(used);
        return "out_of_time";
      }
      const permanent = isPermanent(err);
      const exhausted = permanent || attempt >= maxAttemptsFor(next);
      const message = agentStepErrorMessage(err);
      if (!(err instanceof AgentStepError) && !(err instanceof LlmPermanentError) && !(err instanceof FeatureError)) {
        console.error("[resume agent] 단계 실패", jobRow.id, next.key, (err as Error)?.name ?? "error");
      }
      const { count } = await prisma.resumeAgentStep.updateMany({
        where: { jobId: jobRow.id, key: next.key, status: { not: "done" }, job: { is: { leaseId, runId: jobRow.runId } } },
        data: {
          status: exhausted ? "failed" : "pending",
          error: stripNul(message),
          ...(partial !== undefined ? { output: partial } : {}),
          ...(exhausted ? { summary: { errorCode: errorCodeOf(err) } as Prisma.InputJsonValue } : {}),
          usage: addUsage(priorUsage, used) as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(now()),
        },
      });
      if (count === 0) return "lost";
      if (used) await saveSerial(used);
      return "ok";
    }
  };

  try {
    for (;;) {
      if (controller.signal.aborted) break;
      const rows = await prisma.resumeAgentStep.findMany({ where: { jobId: job.id } });
      const state = evaluateAny(rows, { version, settings, company });
      if (state.fail) {
        const row = rows.find((r) => r.key === state.fail);
        const code: AgentErrorCode = ((row?.summary as { errorCode?: AgentErrorCode } | null)?.errorCode ?? null) || "step_failed";
        await failJob(job, code, row?.error ?? "단계를 끝내지 못했습니다. 다시 시도해 주세요.", state.fail, now());
        finished = true;
        break;
      }
      if (state.next.length === 0) {
        finished = true;
        break;
      }
      // 배치(v2 같은 웨이브의 구역 단계들)는 한 리스 안에서 함께 시작한다: 가장 긴 추정 + 여유가 남아야 시작하고, 모자라면 줄이지 않고 다음 호출로.
      const batch = state.next;
      const remaining = deadlineAt - now();
      const attemptOf = (n: NextStep) => (rows.find((r) => r.key === n.key)?.attempt ?? 0) + 1;
      const need = Math.max(...batch.map((n) => estimateSec(n, attemptOf(n)))) * 1000 * mult + STEP_MARGIN_MS;
      if ((stepsRun > 0 && remaining < need) || remaining < 30_000 || (deps.maxStepsPerCall !== undefined && stepsRun >= deps.maxStepsPerCall)) {
        outOfTime = true;
        break;
      }
      if (stepsRun === 0) {
        // 호출 수는 실제로 단계를 시작할 때만 센다(빈 kick 반복으로 상한을 소진하지 못하게).
        const [bumped] = await prisma.resumeAgentJob.updateManyAndReturn({ where: mineLease, data: { continuations: { increment: 1 } } });
        if (!bumped) break;
        if (bumped.continuations > (version === 2 ? MAX_CONTINUATIONS_V2 : MAX_CONTINUATIONS)) {
          await failJob(job, "continuations", CONTINUATIONS_ERROR, batch[0]!.key, now());
          finished = true;
          break;
        }
      }
      stepsRun++;
      await prisma.resumeAgentJob.updateMany({ where: mineLease, data: { currentStep: batch[0]!.key, round: Math.max(0, batch[0]!.round), updatedAt: new Date(now()) } });
      // 배치 안 구역이 같은 대체 호출(v1 본문·상단 작성기)을 나눠 쓰도록 배치마다 메모를 둔다.
      const memo = new Map<string, Promise<unknown>>();
      const results = await Promise.allSettled(batch.map((n) => runOne(n, rows, memo)));
      const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value : "lost"));
      for (const r of results) if (r.status === "rejected") console.error("[resume agent] 단계 실행 실패", job.id, (r.reason as Error)?.name ?? "error");
      if (outcomes.includes("lost")) break;
      if (outcomes.includes("finished")) {
        finished = true;
        break;
      }
      if (outcomes.includes("out_of_time")) {
        outOfTime = true;
        break;
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

async function saveProgress(job: JobRow, leaseId: string, settings: AgentSettings, used: UsageTotals, now: number, version: PipelineVersion = 1, company = false): Promise<void> {
  const [rows, fresh] = await Promise.all([
    prisma.resumeAgentStep.findMany({ where: { jobId: job.id } }),
    prisma.resumeAgentJob.findFirst({ select: { progress: true, usage: true }, where: { id: job.id, leaseId } }),
  ]);
  if (!fresh) return;
  const progress = progressFrom(rows, settings, (fresh.progress ?? {}) as Progress, version, company);
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
  if (job.targetResumeId) return finalizeRegenerate(job, job.targetResumeId, leaseId, rows, settings, ctx, existing, plan, now, deps);
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
    const done = await completeJob(job, leaseId, rows, settings, resumeId, plan, ctx, now());
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

/**
 * 다시 생성 finalize(중복 버전 없이): 이전 시도가 적어 둔 버전(pendingVersionId)을 지우고 → 새 버전 id를 리스 조건으로 단계 행에 적고 →
 * 대상 이력서의 새 버전으로 저장하고(지원 동기·연락처 등 사용자 칸은 현재 버전에서) → 완료 기록. 소유를 잃었거나 던지면 저장한 버전을 지운다.
 * 이력서가 지워졌으면 saveRegeneratedVersion이 FeatureError(404)를 던진다(영구 실패 — 작업이 실패로 닫힌다).
 */
async function finalizeRegenerate(
  job: JobRow,
  targetResumeId: string,
  leaseId: string,
  rows: readonly StepRow[],
  settings: AgentSettings,
  ctx: StepContext,
  existing: StepRow | null,
  plan: Awaited<ReturnType<typeof prepareFinalize>>,
  now: () => number,
  deps: AdvanceDeps,
): Promise<"done" | "lost"> {
  const pending = PendingVersionSchema.safeParse(existing?.output);
  if (pending.success) await discardRegeneratedVersion(job.userId, targetResumeId, pending.data.pendingVersionId);
  const { newVersionId } = await import("@/lib/resumes/service");
  const versionId = newVersionId();
  const { count } = await prisma.resumeAgentStep.updateMany({
    where: { jobId: job.id, key: "finalize", status: { not: "done" }, job: { is: { leaseId, runId: job.runId } } },
    data: { output: { pendingVersionId: versionId } as Prisma.InputJsonValue },
  });
  if (count === 0) return "lost";
  const version = await saveRegeneratedVersion(job.userId, targetResumeId, plan.create.document, { mode: "agent", versionId, templateId: ctx.job.input.templateId });
  try {
    await deps.onResumeCreated?.(targetResumeId);
    const done = await completeJob(job, leaseId, rows, settings, targetResumeId, plan, ctx, now(), { versionNo: version.versionNo });
    if (!done) {
      await discardRegeneratedVersion(job.userId, targetResumeId, version.id);
      return "lost";
    }
  } catch (err) {
    await discardRegeneratedVersion(job.userId, targetResumeId, version.id);
    throw err;
  }
  await applyRegeneratedMeta(job.userId, targetResumeId, ctx.job.input);
  return "done";
}

/** finalize: 소유(run·리스) 확인 update가 1행일 때만 완료·알림. 아니면 false(호출자가 만든 이력서를 지운다). regenerated면 다시 생성 알림. */
async function completeJob(
  job: JobRow,
  leaseId: string,
  rows: readonly StepRow[],
  settings: AgentSettings,
  resumeId: string,
  plan: { report: AgentReport; missingInfo: string[]; motivationSuggestion: MotivationSuggestResponse["suggestion"] | null; create: { jdText?: string | null } },
  ctx: StepContext,
  now: number,
  regenerated: { versionNo: number } | null = null,
): Promise<boolean> {
  const { report, missingInfo } = plan;
  const progress = { ...progressFrom(rows, settings, (job.progress ?? {}) as Progress, pipelineOf(ctx.pipeline), ctx.job.input.kind === "company"), stopReason: report.stopReason };
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
    // v2: 파이프라인이 미리 계산한 지원 동기 추천을 이 이력서의 마지막 추천으로(편집 화면이 LLM 호출 없이 바로 펼친다).
    if (plan.motivationSuggestion) {
      const { saveMotivationSuggestion } = await import("@/lib/resumes/motivation");
      await saveMotivationSuggestion({ resumeId, userId: job.userId, suggestion: plan.motivationSuggestion, source: "agent", agentJobId: job.id, jdText: plan.create.jdText ?? "" }, tx);
    }
    return true;
  });
  if (!done) return false;
  const final = report.finalPanel ? ` · 심사 ${report.finalPanel.passCount}/7 통과` : "";
  const fit = report.rounds.find((r) => r.round === report.chosenRound)?.matchScore;
  const stats = `${final}${fit !== undefined ? ` · 적합도 ${fit}` : ""} · 채울 정보 ${report.gaps.length}개`;
  await notify(
    job.userId,
    regenerated
      ? {
          kind: "resume-agent-completed",
          title: "AI 에이전트가 이력서를 다시 생성했습니다",
          body: `${job.label} — 새 버전 v${regenerated.versionNo}${stats}`,
          link: regeneratedResumeHref(resumeId, "agent"),
        }
      : { kind: "resume-agent-completed", title: "AI 에이전트 이력서가 완성됐습니다", body: `${job.label}${stats}`, link: `/app/resumes/${resumeId}?report=1` },
  );
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

/**
 * 화면이 이어 가기(POST …/advance)를 보내야 하는 내 진행 중 작업 id(toAgentJobView의 needsKick과 같은 조건).
 * 동시 작업이 여러 개라 보고 있는 작업 말고도 밀어 줘야 한다 — 진행 화면 폴링(exceptId = 그 작업)과 이력서 목록 폴링이 쓴다.
 */
export async function agentJobsNeedingKick(userId: string, opts: { exceptId?: string; now?: number } = {}): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const idleBefore = new Date(now - (chainEnabled() ? IDLE_KICK_MS : 0));
  const rows = await prisma.resumeAgentJob.findMany({
    select: { id: true },
    where: {
      userId,
      ...(opts.exceptId ? { id: { not: opts.exceptId } } : {}),
      OR: [
        { status: "waiting", leaseId: null, updatedAt: { lt: idleBefore } },
        { status: "running", leaseExpiresAt: { lt: new Date(now) } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: MAX_ACTIVE_AGENT_JOBS,
  });
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// 실행기(맥미니) 주기 점검
// ---------------------------------------------------------------------------

/** 실행기의 주기 점검이 한 번에 실행하는 작업 수(전 사용자 합계 — 서명 호출로 바로 받은 작업은 따로다). RESUME_AGENT_RUNNER_CONCURRENCY(1~16), 기본 3. */
export function runnerConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.RESUME_AGENT_RUNNER_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 3;
}
/** 대기 중인 작업을 실행기가 주워 가기 전 여유(방금 만든 작업의 서명 호출·방금 끝난 호출의 연쇄와 겹치지 않게). */
export const RUNNER_PICKUP_IDLE_MS = 10_000;
/** 이 프로세스의 주기 점검이 실행 중인 작업 id. */
const runnerActive = new Set<string>();

/**
 * 실행기 주기 점검(runner-loop.ts): 이어 줄 호출이 없는 작업(대기 중 + 리스 없음, 또는 리스 만료)을 전 사용자에서 찾아 이 프로세스에서 실행한다.
 * 서명 호출이 닿지 않았거나(네트워크·재시작) Vercel 쪽 실행이 시간 예산으로 멈춘 작업도 화면 없이 이어진다. 작업은 그 행의 userId로만 실행하고
 * 리스가 중복 실행을 막는다. 기다리지 않고 시작만 한다 — 반환값은 이번에 시작한 작업 수.
 */
export async function sweepRunnerJobs(
  opts: { now?: number; concurrency?: number; advance?: (jobId: string, o: { runId: string; deadlineAt: number }) => Promise<void> } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const free = (opts.concurrency ?? runnerConcurrency()) - runnerActive.size;
  if (free <= 0) return 0;
  const rows = await prisma.resumeAgentJob.findMany({
    select: { id: true, runId: true },
    where: {
      ...(runnerActive.size ? { id: { notIn: [...runnerActive] } } : {}),
      // 이 빌드보다 새 버전의 작업은 집지 않는다(실행기를 다시 빌드하기 전에는 Vercel이 실행한다).
      schemaVersion: { lte: AGENT_SCHEMA_VERSION },
      OR: [
        { status: "waiting", leaseId: null, updatedAt: { lt: new Date(now - RUNNER_PICKUP_IDLE_MS) } },
        { status: "running", leaseExpiresAt: { lt: new Date(now) } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: free,
  });
  const advance = opts.advance ?? ((jobId, o) => advanceAgentJob(jobId, o));
  for (const r of rows) {
    runnerActive.add(r.id);
    void advance(r.id, { runId: r.runId, deadlineAt: now + SELF_HOSTED_AGENT_TIME_LIMIT_MS })
      .catch(() => undefined)
      .finally(() => runnerActive.delete(r.id));
  }
  return rows.length;
}

/** 이 이력서의 심사 리포트 목록 항목(최근 순). */
export interface AgentReportHistoryItem {
  jobId: string;
  completedAt: number;
  regenerate: boolean;
}

/**
 * 이력서 편집 화면의 심사 리포트: 기본은 완료된 작업 중 최근 것(다시 생성하면 새 리포트가 보인다), jobId를 주면 그 작업의 리포트(이전 리포트 보기).
 * history는 이 이력서에 붙은 완료 리포트 전부(최근 순, 최대 10개). 리포트 화면은 서버 컴포넌트가 이것을 직접 읽는다.
 */
export async function getAgentReportForResume(
  userId: string,
  resumeId: string,
  jobId?: string | null,
): Promise<{ jobId: string; report: AgentReport; history: AgentReportHistoryItem[] } | null> {
  const rows = await prisma.resumeAgentJob.findMany({
    select: { id: true, completedAt: true, targetResumeId: true },
    where: { resumeId, userId, status: "completed", report: { not: Prisma.DbNull } },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: 10,
  });
  if (rows.length === 0) return null;
  const pick = (jobId && rows.find((r) => r.id === jobId)) || rows[0]!;
  const row = await prisma.resumeAgentJob.findFirst({ select: { id: true, report: true }, where: { id: pick.id, userId } });
  if (!row?.report) return null;
  const { AgentReportSchema } = await import("./schemas");
  const parsed = AgentReportSchema.safeParse(row.report);
  if (!parsed.success) return null;
  const history = rows.map((r) => ({ jobId: r.id, completedAt: r.completedAt?.getTime() ?? 0, regenerate: r.targetResumeId !== null }));
  return { jobId: row.id, report: parsed.data, history };
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
      ...(row.targetResumeId ? { regenerate: true, targetResumeId: row.targetResumeId } : {}),
      stageLabel: kind
        ? kind.kind === "review" || kind.kind === "revise" || kind.kind === "compose" || kind.kind === "critique"
          ? stepTitle(kind.kind, kind.round)
          : kind.kind === "section"
            ? kind.round === 0
              ? "구역 에이전트가 쓰는 중"
              : `지시받은 구역 다시 쓰는 중(${kind.round}회차)`
            : AGENT_STEP_LABELS[kind.kind].label
        : "진행 중",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 다시 시도·취소
// ---------------------------------------------------------------------------

/**
 * 다시 시도: 실패한 작업을 새 runId로 — 끝난 단계는 건너뛰고 실패한 단계부터(실패 단계 행만 pending·attempt 0).
 * from=jd면 처음부터(단계 행을 모두 지운다). 스키마 버전이 다르면 처음부터. beforeRestart는 상태 확인 뒤(에이전트는 하루 한도가 없어 라우트는 넘기지 않는다).
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
  const busy = await busyAgentJob(userId, prisma, row.id);
  if (busy) throw new AgentBusyError(busy);
  if (!row.targetResumeId) await assertResumeSlots(userId, now);
  await opts.beforeRestart?.();
  const runId = nanoid();
  const fresh = opts.from === "jd" || row.schemaVersion !== AGENT_SCHEMA_VERSION;
  const updated = await prisma.$transaction(async (tx) => {
    if (row.targetResumeId) await assertRegenerateSlot(tx, userId, row.targetResumeId, { now, exceptAgentJobId: row.id });
    await lockAgentJobs(tx, userId);
    const again = await busyAgentJob(userId, tx, row.id);
    if (again) throw new AgentBusyError(again);
    // 동시 작업이 여러 개라 잠금 안에서 이력서 수도 다시 센다(시작과 같다 — 이 행은 아직 failed·canceled라 세지 않는다).
    if (!row.targetResumeId) await assertResumeSlots(userId, now, tx);
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
        progress: fresh
          ? (row.progress as Progress | null)?.pinned
            ? ({ pinned: (row.progress as Progress).pinned } as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull
          : ({ ...((row.progress ?? {}) as Progress), errorCode: null } as unknown as Prisma.InputJsonValue),
        startedAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
    if (!next) return null;
    if (fresh) await tx.resumeAgentStep.deleteMany({ where: { jobId: row.id } });
    else if (pipelineOf(row.pipelineVersion) === 2) {
      // v2: 실패로 닫은 단계(failedStep)와 진행 중이던 행만 되살린다. 계획이 이미 처리한 실패(재작성 구역 → 이전 결과, 지원 동기 → 건너뜀,
      // critique → plateau, final_panel → 건너뜀)는 그대로 두어 다시 시도가 라운드를 새로 돌지 않게 한다.
      await tx.resumeAgentStep.updateMany({
        where: { jobId: row.id, OR: [{ status: { in: ["running", "pending"] } }, ...(row.failedStep ? [{ key: row.failedStep, status: "failed" }] : [])] },
        data: { status: "pending", attempt: 0, error: null },
      });
    } else await tx.resumeAgentStep.updateMany({ where: { jobId: row.id, status: { in: ["failed", "running", "pending"] } }, data: { status: "pending", attempt: 0, error: null } });
    return next;
  });
  if (!updated) throw new FeatureError("다른 요청이 먼저 이 작업을 다시 시작했습니다. 새로고침해 주세요.", 409);
  const steps = await prisma.resumeAgentStep.findMany({ where: { jobId: row.id } });
  return { job: toAgentJobView(updated, steps, now), runId };
}

/** 같은 입력으로 빠른 초안(단일 초안 작업)을 만들 입력. 완성된 작업이면 409, 입력이 만료됐으면 409. 이 작업은 호출자가 시작 뒤 취소로 닫는다. */
export async function agentJobInputForFallback(userId: string, jobId: string): Promise<CreateResumeInput | null> {
  return (await agentJobFallback(userId, jobId))?.input ?? null;
}

/** 빠른 초안 전환 입력 + 다시 생성 대상(있으면 초안 작업도 같은 이력서의 새 버전을 저장한다). */
export async function agentJobFallback(
  userId: string,
  jobId: string,
): Promise<{ input: CreateResumeInput; regenerate: { resumeId: string; label: string; exceptAgentJobId: string } | null } | null> {
  const row = await prisma.resumeAgentJob.findFirst({ where: { id: jobId, userId } });
  if (!row) return null;
  if (row.status === "completed") throw new FeatureError("이미 완성된 이력서입니다.", 409);
  const parsed = CreateResumeInputSchema.safeParse(row.input);
  if (!parsed.success) throw new FeatureError(INPUT_ERROR, 409);
  return { input: parsed.data, regenerate: row.targetResumeId ? { resumeId: row.targetResumeId, label: row.label, exceptAgentJobId: row.id } : null };
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
