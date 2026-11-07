import "server-only";
/**
 * AI 이력서 초안 작업(resume_draft_jobs). 새 이력서 화면의 '초안 만들기'가 오래 걸려도(출력 상한 128K — 수 분) 화면이 멈추지 않게,
 * 요청은 작업 행만 만들고 202로 돌아가며 초안은 응답 뒤(after()) 쓴다. 진행 화면(/app/resumes/drafts/[id])이 폴링한다.
 *
 * 흐름(면접 질문 생성·그래프 채팅과 같은 after() 패턴):
 *   startResumeDraftJob → (라우트가 after(() => runResumeDraftJob(...)) 예약) → GET /api/resumes/drafts/[id]로 상태 확인
 *   runResumeDraftJob: 자료 모으기('material') → AI 초안('writing') → 저장('saving') → 'completed'(이력서 id) / 'failed'(문구)
 *   끝나면 알림(notifications)을 남긴다 — 화면을 떠나도 상단 알림 버튼으로 결과를 안다.
 * 실행 중 쓰기(완료 기록 포함)는 runId·status='running' 조건으로 건다. 시작 후 draftStaleMs()가 지나도 'running'이면(서버 재시작·플랫폼 시간 초과로
 * after()가 죽음) 읽을 때(진행 화면·이력서 목록·알림 폴링) 'failed'로 닫고 실패 알림을 남기며 다시 시도를 허용한다. 다시 시도는 새 runId로 처음부터 실행한다(남아 있던 input으로).
 * input(공고 JD 포함)은 다시 시도에만 쓰므로 완료하면 지우고, 끝난 작업은 DRAFT_JOB_RETENTION_MS 뒤 지운다.
 */
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, Prisma } from "@/lib/db/client";
import { stripNul, stripNulDeep } from "@/lib/db/errors";
import { isProviderId, type ProviderId } from "@/lib/domain/providers";
import { createLlmClient, LlmPermanentError, type LlmClient, type LlmUsageContext } from "@/lib/llm";
import { withLlmDeadline } from "@/lib/llm/deadline";
import { notify } from "@/lib/notifications/service";
import { stageErrorMessage } from "@/lib/panel/runner";
import { graphEnabled } from "@/lib/graph/service";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { draftContextFor, saveNewResume } from "./create";
import { generateResumeDraft, loadDraftMaterial } from "./draft";
import {
  RESUME_DRAFT_JOB_STAGES,
  RESUME_DRAFT_JOB_STATUSES,
  type ResumeDraftJobStage,
  type ResumeDraftJobStatus,
  type ResumeDraftJobView,
} from "./draft-job-types";
import { CreateResumeInputSchema, MAX_RESUMES_PER_USER, type CreateResumeInput, type ResumeDraftSource } from "./types";

/** 초안 라우트(POST /api/resumes, 다시 시도)의 maxDuration과 같아야 한다(라우트는 리터럴로 적는다). */
export const DRAFT_ROUTE_MAX_DURATION_SEC = 300;
/** 자체 호스팅(플랫폼 시간 제한 없음)에서 초안 한 번에 주는 시간. 출력 상한 128K를 다 쓰면 수 분 걸린다. */
export const SELF_HOSTED_DRAFT_TIME_LIMIT_MS = 15 * 60_000;
/** 동시에 진행할 수 있는 초안 작업 수(사용자당). */
export const MAX_ACTIVE_DRAFT_JOBS = 3;
/** 끝난 작업을 남겨 두는 기간. */
export const DRAFT_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** 이력서 목록에 실패한 작업을 보여 주는 기간. */
export const FAILED_JOB_LIST_MS = 24 * 60 * 60_000;

export const DRAFT_JOB_NOT_FOUND = "초안 작업을 찾을 수 없습니다.";
const STALE_ERROR = "초안 작업이 중간에 끊겼습니다(서버 재시작 또는 시간 제한). 다시 시도해 주세요.";

/**
 * 초안 한 번의 시간 상한. Vercel은 라우트 maxDuration에서 30초 여유를 뺀 값(플랫폼이 함수를 끊기 전에 스스로 멈추고 실패로 기록),
 * 그 밖은 SELF_HOSTED_DRAFT_TIME_LIMIT_MS.
 */
export function draftTimeLimitMs(env: Record<string, string | undefined> = process.env): number {
  return env.VERCEL ? Math.max(30, DRAFT_ROUTE_MAX_DURATION_SEC - 30) * 1000 : SELF_HOSTED_DRAFT_TIME_LIMIT_MS;
}

/** 시작 후 이 시간이 지나도 'running'이면 멈춘 것으로 본다(시간 상한 + 저장 여유 60초). */
export function draftStaleMs(env: Record<string, string | undefined> = process.env): number {
  return draftTimeLimitMs(env) + 60_000;
}

interface DraftJobRow {
  id: string;
  userId: string;
  runId: string;
  status: string;
  stage: string;
  label: string;
  input: Prisma.JsonValue | null;
  provider: string | null;
  error: string | null;
  resumeId: string | null;
  result: Prisma.JsonValue | null;
  attempts: number;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);

export function isDraftJobStale(row: Pick<DraftJobRow, "status" | "startedAt">, now: number = Date.now(), staleMs: number = draftStaleMs()): boolean {
  return row.status === "running" && now - row.startedAt.getTime() > staleMs;
}

export function toDraftJobView(row: DraftJobRow): ResumeDraftJobView {
  const status: ResumeDraftJobStatus = (RESUME_DRAFT_JOB_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as ResumeDraftJobStatus)
    : "failed";
  const stage: ResumeDraftJobStage = (RESUME_DRAFT_JOB_STAGES as readonly string[]).includes(row.stage) ? (row.stage as ResumeDraftJobStage) : "material";
  const result = (row.result ?? {}) as { notes?: unknown; missingInfo?: unknown };
  return {
    id: row.id,
    status,
    stage,
    label: row.label,
    error: row.error,
    resumeId: row.resumeId,
    notes: strings(result.notes),
    missingInfo: strings(result.missingInfo),
    canRetry: status === "failed" && row.input !== null,
    attempts: row.attempts,
    startedAt: row.startedAt.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    completedAt: row.completedAt?.getTime() ?? null,
  };
}

/** 화면 표시용 대상 이름. */
export function draftJobLabel(input: Pick<CreateResumeInput, "kind" | "company" | "roleTitle" | "title">): string {
  if (input.title?.trim()) return input.title.trim().slice(0, 120);
  if (input.kind === "general") return "공용 이력서";
  return [input.company.trim(), input.roleTitle.trim()].filter(Boolean).join(" · ").slice(0, 120) || "새 이력서";
}

/** 요청 안에서 바로 알 수 있는 자료 문제(그래프 저장소 없음·진단 없음·재작성본 없음)를 먼저 거절한다. 그래프 내용 확인은 작업에서. */
async function precheckSource(user: { id: string; name: string | null }, source: ResumeDraftSource): Promise<void> {
  if (source.kind === "graph") {
    if (!graphEnabled()) throw new FeatureError("경험 그래프 저장소(Neo4j)가 설정되지 않아 그래프에서 초안을 만들 수 없습니다.", 503);
    return;
  }
  if (source.kind === "diagnosis") await loadDraftMaterial(user, source);
}

/** 이력서 수 + 진행 중인 초안 작업 수가 상한에 닿았으면 409. 빈 문서·복사 생성도 이것으로 센다(진행 중인 초안이 저장 단계에서 막히지 않게). */
export async function assertResumeSlots(userId: string, now: number = Date.now(), db: Prisma.TransactionClient = prisma): Promise<number> {
  const resumes = await db.companyResume.count({ where: { userId } });
  const active = await db.resumeDraftJob.count({
    where: { userId, status: "running", startedAt: { gt: new Date(now - draftStaleMs()) } },
  });
  // 진행 중인 그래프 에이전트 작업(running·waiting)도 곧 이력서가 된다.
  const agents = await db.resumeAgentJob.count({ where: { userId, status: { in: ["running", "waiting"] } } });
  if (resumes + active + agents >= MAX_RESUMES_PER_USER) {
    throw new FeatureError(`이력서는 ${MAX_RESUMES_PER_USER}개까지 만들 수 있습니다. 쓰지 않는 이력서를 지워 주세요.`, 409);
  }
  return active;
}

async function assertCapacity(userId: string, now: number, db: Prisma.TransactionClient = prisma): Promise<void> {
  const active = await assertResumeSlots(userId, now, db);
  if (active >= MAX_ACTIVE_DRAFT_JOBS) {
    throw new FeatureError(`AI 초안은 동시에 ${MAX_ACTIVE_DRAFT_JOBS}개까지 만들 수 있습니다. 진행 중인 초안이 끝난 뒤 다시 시도해 주세요.`, 409);
  }
}

/** 같은 사용자의 초안 시작·다시 시도를 줄 세운다(트랜잭션 안의 상한 확인과 행 쓰기가 겹쳐 상한을 넘지 않게). */
async function lockDraftJobs(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`resume-draft:${userId}`}))`;
}

export interface StartDraftJobDeps {
  now?: () => number;
  /** 테스트용: 엔진 확인을 건너뛴다. */
  resolveProvider?: (requested: string | null) => Promise<ProviderId>;
  /** 레이트 리밋 등 마지막 확인(라우트가 넘긴다 — 잘못된 요청이 한도를 깎지 않게 다른 확인 뒤에 부른다). */
  beforeCreate?: () => Promise<void>;
}

/**
 * 초안 작업 시작: 입력·자료·엔진·이력서 수를 확인하고 'running' 행을 만든다. 반환한 runId로 라우트가 after()를 예약한다.
 * AI 초안 출처(그래프·진단)만 받는다 — 빈 문서·복사는 createResumeFromInput으로 바로 만든다.
 */
export async function startResumeDraftJob(
  user: { id: string; name: string | null },
  input: CreateResumeInput,
  deps: StartDraftJobDeps = {},
): Promise<{ job: ResumeDraftJobView; runId: string; provider: ProviderId }> {
  if (input.source.kind === "blank" || input.sourceResumeId) throw new FeatureError("AI 초안 출처(경험 그래프·진단 재작성본)를 골라 주세요.", 400);
  const now = deps.now?.() ?? Date.now();
  await precheckSource(user, input.source);
  const provider = await (deps.resolveProvider ?? resolveRequestedProvider)(input.provider ?? null);
  await assertCapacity(user.id, now);
  await deps.beforeCreate?.();

  // 끝난 지 오래된 작업은 정리한다(진행 화면 링크는 알림 보관 기간보다 짧게 남는다 — 이력서는 그대로).
  await prisma.resumeDraftJob
    .deleteMany({ where: { userId: user.id, status: { not: "running" }, updatedAt: { lt: new Date(now - DRAFT_JOB_RETENTION_MS) } } })
    .catch(() => undefined);

  const runId = nanoid();
  const stored = { ...input, provider } satisfies CreateResumeInput;
  // 앞의 확인은 빨리 거절하려는 것이고, 동시에 온 요청이 함께 통과하지 않게 잠금 안에서 한 번 더 세고 만든다.
  const row = await prisma.$transaction(async (tx) => {
    await lockDraftJobs(tx, user.id);
    await assertCapacity(user.id, now, tx);
    return tx.resumeDraftJob.create({
      data: {
        id: nanoid(16),
        userId: user.id,
        runId,
        status: "running",
        stage: "material",
        label: stripNul(draftJobLabel(input)),
        input: stripNulDeep(stored) as Prisma.InputJsonValue,
        provider,
        startedAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
  });
  return { job: toDraftJobView(row), runId, provider };
}

/** 멈춘 작업을 실패로 닫는다(같은 runId일 때만). 닫았으면 true(알림도 남긴다). */
async function closeStale(row: DraftJobRow, now: number): Promise<boolean> {
  const { count } = await prisma.resumeDraftJob.updateMany({
    where: { id: row.id, runId: row.runId, status: "running" },
    data: { status: "failed", error: STALE_ERROR, updatedAt: new Date(now) },
  });
  if (count > 0) await notifyFailed(row.userId, row.id, row.label, STALE_ERROR);
  return count > 0;
}

/** 내 초안 작업(멈춘 작업은 이때 실패로 닫는다). 남의 것이면 null. */
export async function getDraftJob(userId: string, jobId: string, now: number = Date.now()): Promise<ResumeDraftJobView | null> {
  let row = (await prisma.resumeDraftJob.findFirst({ where: { id: jobId, userId } })) as DraftJobRow | null;
  if (!row) return null;
  if (isDraftJobStale(row, now) && (await closeStale(row, now))) {
    row = (await prisma.resumeDraftJob.findFirst({ where: { id: jobId, userId } })) as DraftJobRow | null;
    if (!row) return null;
  }
  return toDraftJobView(row);
}

/**
 * 이 사용자의 멈춘 작업을 모두 실패로 닫고 알린다(알림 폴링이 부른다 — 진행 화면·이력서 목록을 다시 열지 않아도
 * 플랫폼 시간 초과·서버 재시작으로 끊긴 초안의 결과를 알림으로 받게). 닫은 개수.
 */
export async function sweepStaleDraftJobs(userId: string, now: number = Date.now()): Promise<number> {
  const rows = (await prisma.resumeDraftJob.findMany({
    where: { userId, status: "running", startedAt: { lt: new Date(now - draftStaleMs()) } },
    take: 20,
  })) as DraftJobRow[];
  let closed = 0;
  for (const row of rows) if (await closeStale(row, now)) closed++;
  return closed;
}

/**
 * 이력서 목록에 보일 작업: 진행 중 + 최근 하루 안에 실패한 것(최근 순). 멈춘 작업은 실패로 닫는다.
 * 그래프 에이전트 작업(resume_agent_jobs)도 같은 뷰로 함께 돌려준다(mode 'agent', href는 에이전트 진행 화면).
 */
export async function listVisibleDraftJobs(userId: string, now: number = Date.now()): Promise<ResumeDraftJobView[]> {
  const rows = (await prisma.resumeDraftJob.findMany({
    where: {
      userId,
      OR: [{ status: "running" }, { status: "failed", input: { not: Prisma.DbNull }, updatedAt: { gt: new Date(now - FAILED_JOB_LIST_MS) } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
  })) as DraftJobRow[];
  const out: ResumeDraftJobView[] = [];
  for (const row of rows) {
    if (isDraftJobStale(row, now) && (await closeStale(row, now))) {
      out.push(toDraftJobView({ ...row, status: "failed", error: STALE_ERROR }));
    } else out.push(toDraftJobView(row));
  }
  const { listVisibleAgentJobs } = await import("@/lib/resume-agent/jobs");
  const agents = await listVisibleAgentJobs(userId, now).catch(() => [] as ResumeDraftJobView[]);
  return [...agents, ...out].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
}

/**
 * 다시 시도: 실패했거나 멈춘 작업을 새 runId로 'running'(자료 모으기부터)에 둔다. beforeRestart(레이트 리밋)는 상태 확인 뒤에 부른다.
 * 남의 작업이면 null, 다시 시도할 수 없으면 FeatureError(409).
 */
export async function restartDraftJob(
  userId: string,
  jobId: string,
  deps: { now?: () => number; beforeRestart?: () => Promise<void> } = {},
): Promise<{ job: ResumeDraftJobView; runId: string; provider: ProviderId } | null> {
  const now = deps.now?.() ?? Date.now();
  const row = (await prisma.resumeDraftJob.findFirst({ where: { id: jobId, userId } })) as DraftJobRow | null;
  if (!row) return null;
  const stale = isDraftJobStale(row, now);
  if (row.status === "running" && !stale) throw new FeatureError("초안을 쓰는 중입니다. 잠시 후 다시 확인해 주세요.", 409);
  if (row.status === "completed") throw new FeatureError("이미 완성된 초안입니다.", 409);
  const parsed = CreateResumeInputSchema.safeParse(row.input);
  if (!parsed.success) throw new FeatureError("다시 시도할 입력이 남아 있지 않습니다. 새 이력서 화면에서 다시 만들어 주세요.", 409);
  // 저장해 둔 엔진을 지금 쓸 수 없으면 기본 엔진으로.
  const saved = row.provider && isProviderId(row.provider) ? row.provider : null;
  const provider = await resolveRequestedProvider(saved).catch(() => resolveRequestedProvider(null));
  await assertCapacity(userId, now);
  await deps.beforeRestart?.();
  const runId = nanoid();
  const updated = await prisma.$transaction(async (tx) => {
    await lockDraftJobs(tx, userId);
    await assertCapacity(userId, now, tx);
    const [next] = await tx.resumeDraftJob.updateManyAndReturn({
      where: { id: jobId, userId, runId: row.runId, status: row.status },
      data: {
        runId,
        status: "running",
        stage: "material",
        error: null,
        provider,
        attempts: { increment: 1 },
        startedAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
    return next;
  });
  if (!updated) throw new FeatureError("다른 요청이 먼저 이 초안을 다시 시작했습니다. 새로고침해 주세요.", 409);
  return { job: toDraftJobView(updated), runId, provider };
}

/** 사용자에게 보여도 되는 실패 문구. */
export function draftErrorMessage(err: unknown): string {
  if (err instanceof FeatureError) return err.message;
  if (err instanceof LlmPermanentError) return `초안을 만들지 못했습니다. ${stageErrorMessage(err).replace("이 단계의 ", "")}`;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "초안을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요.";
  }
  return "초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function notifyFailed(userId: string, jobId: string, label: string, error: string): Promise<void> {
  return notify(userId, {
    kind: "resume-draft-failed",
    title: "AI 이력서 초안을 만들지 못했습니다",
    body: `${label} — ${error}`,
    link: `/app/resumes/drafts/${jobId}`,
  });
}

export interface RunDraftJobDeps {
  createClient?: (provider: ProviderId, usage: LlmUsageContext) => LlmClient;
  /** 시간 상한(기본 draftTimeLimitMs()). 테스트용. */
  timeLimitMs?: number;
  now?: () => number;
  /** 테스트용: 이력서를 저장한 직후(완료 기록 전)에 부른다. */
  onSaved?: (resumeId: string) => Promise<void>;
}

class DraftSupersededError extends Error {}

async function discardResume(userId: string, resumeId: string): Promise<void> {
  try {
    const { deleteResume } = await import("./service");
    await deleteResume(userId, resumeId);
  } catch (err) {
    console.error("[resume draft] 버려진 이력서 삭제 실패", resumeId, err);
  }
}

/**
 * 백그라운드 실행(after()). 던지지 않는다. 이미 끝났거나 runId가 바뀌었으면(다시 시도·멈춤 판정) 아무것도 쓰지 않는다.
 * 저장 직전에 한 번 더 소유를 확인해, 버려진 실행이 이력서를 만들지 않게 한다.
 */
export async function runResumeDraftJob(userId: string, jobId: string, runId: string, provider: ProviderId, deps: RunDraftJobDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const mine = { id: jobId, userId, runId, status: "running" } satisfies Prisma.ResumeDraftJobWhereInput;
  const setStage = async (stage: ResumeDraftJobStage) => {
    const { count } = await prisma.resumeDraftJob.updateMany({ where: mine, data: { stage, updatedAt: new Date(now()) } });
    if (count === 0) throw new DraftSupersededError();
  };
  let label = "새 이력서";
  // 저장은 됐는데 완료 기록 전에 실패하면 이 이력서를 지운다(작업은 실패로 보이는데 이력서만 남지 않게).
  let savedResumeId: string | null = null;
  try {
    const row = (await prisma.resumeDraftJob.findFirst({ where: mine })) as DraftJobRow | null;
    if (!row) return;
    label = row.label;
    const parsed = CreateResumeInputSchema.safeParse(row.input);
    if (!parsed.success) throw new FeatureError("초안 입력을 읽지 못했습니다. 새 이력서 화면에서 다시 만들어 주세요.", 400);
    const input = parsed.data;
    const user = await prisma.user.findUnique({ select: { id: true, name: true, email: true }, where: { id: userId } });
    if (!user) return;

    const material = await loadDraftMaterial(user, input.source);
    if (!material) throw new FeatureError("AI 초안 출처를 찾지 못했습니다.", 400);
    await setStage("writing");

    const client = (deps.createClient ?? createLlmClient)(provider, { userId, referenceId: jobId });
    // 시간 상한은 작업 시작 시각부터 잰다(요청 처리·자료 모으기에 쓴 시간을 빼야 플랫폼이 끊기 전에 스스로 실패를 기록한다).
    // 남은 시간이 거의 없어도 최소 1초는 준다(상한 자체보다 길게는 주지 않는다).
    const limitMs = deps.timeLimitMs ?? draftTimeLimitMs();
    const timeLimitMs = Math.min(limitMs, Math.max(1_000, row.startedAt.getTime() + limitMs - now()));
    const { draft } = await withLlmDeadline(
      undefined,
      (signal) => generateResumeDraft(client, draftContextFor(user, input, material), signal),
      { timeoutMs: timeLimitMs, message: "AI 초안을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도하거나 빈 문서로 시작해 주세요." },
    );
    await setStage("saving");

    // 그사이 연결할 공고가 지워졌으면 공고 없이 만든다(FK 위반 방지).
    let postingId = input.kind === "general" ? null : (input.postingId ?? null);
    if (postingId && !(await prisma.jobPosting.findFirst({ select: { id: true }, where: { id: postingId, userId } }))) postingId = null;
    const { resume } = await saveNewResume(userId, { ...input, postingId }, draft.document, material);
    savedResumeId = resume.id;
    await deps.onSaved?.(resume.id);

    // 아직 이 실행이 'running'으로 소유할 때만 완료로 바꾼다. 그사이 멈춤 판정('failed', 실패 알림을 이미 보냄)이나
    // 다시 시도(새 runId)가 있었으면 이 결과는 버린다 — 실패 알림 뒤에 완료 알림이 또 가지 않게.
    const { count } = await prisma.resumeDraftJob.updateMany({
      where: mine,
      data: {
        status: "completed",
        stage: "saving",
        error: null,
        resumeId: resume.id,
        result: stripNulDeep({ notes: draft.notes, missingInfo: draft.missingInfo }) as Prisma.InputJsonValue,
        input: Prisma.DbNull,
        completedAt: new Date(now()),
        updatedAt: new Date(now()),
      },
    });
    if (count === 0) {
      // 멈춤 판정·다시 시도로 이 실행을 버렸다 — 이 실행이 만든 이력서는 지운다(같은 초안이 둘 생기지 않게).
      await discardResume(userId, resume.id);
      return;
    }
    savedResumeId = null;
    await notify(userId, {
      kind: "resume-draft-completed",
      title: "AI 이력서 초안이 완성됐습니다",
      body: draft.missingInfo.length > 0 ? `${label} — 채워야 할 정보 ${draft.missingInfo.length}개` : label,
      link: `/app/resumes/${resume.id}`,
    });
  } catch (err) {
    if (savedResumeId) await discardResume(userId, savedResumeId);
    if (err instanceof DraftSupersededError) return;
    if (!(err instanceof LlmPermanentError) && !(err instanceof FeatureError)) console.error("[resume draft]", jobId, err);
    const message = draftErrorMessage(err);
    const { count } = await prisma.resumeDraftJob
      .updateMany({ where: mine, data: { status: "failed", error: stripNul(message), updatedAt: new Date(now()) } })
      .catch(() => ({ count: 0 }));
    if (count > 0) await notifyFailed(userId, jobId, label, message);
  }
}
