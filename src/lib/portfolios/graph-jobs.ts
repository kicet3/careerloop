import "server-only";
/**
 * 경험 그래프로 포트폴리오 만들기 작업(portfolio_draft_jobs). AI 이력서 초안 작업(src/lib/resumes/draft-jobs.ts)과 같은 흐름:
 *   startGraphPortfolioJob → (라우트가 after(() => runGraphPortfolioJob(...)) 예약) → GET /api/portfolios/graph/jobs/[id]로 상태 확인
 *   runGraphPortfolioJob: 자료 모으기('material') → AI 작성('writing') → 저장('saving') → 'completed'(포트폴리오 id) / 'failed'(문구)
 *   끝나면 알림을 남긴다(진행 화면을 떠나도 결과를 안다).
 * 실행은 claimGraphPortfolioRun(조건부 UPDATE)으로 시작해 Python 워커(worker/app/jobs/portfolio_graph.py)와 한쪽만 실행한다.
 * 실행 중 쓰기는 runId·status='running' 조건으로 건다. 시작 후 graphPortfolioStaleMs()가 지나도 'running'이면 읽을 때(진행 화면·알림 목록)
 * 'failed'로 닫고 실패 알림을 남기며 다시 시도를 허용한다. input은 다시 시도에만 쓰므로 완료하면 지운다.
 *
 * 사용자 간 격리: 시작할 때 요청 사용자의 그래프로 고른 프로젝트 id를 확인하고(다른 사용자의 id면 400), 실행할 때 다시 그 사용자의 그래프만 읽어
 * 소유자 확인(assertGraphOwner) 뒤 프롬프트에 넣는다(graph-material.ts). 다시 만들기 대상 포트폴리오·강조할 공고도 그 사용자의 것만 받는다.
 */
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, Prisma } from "@/lib/db/client";
import { stripNul, stripNulDeep } from "@/lib/db/errors";
import {
  GRAPH_PORTFOLIO_JOB_STAGES,
  GRAPH_PORTFOLIO_JOB_STATUSES,
  graphPortfolioToMarkdown,
  type GraphPortfolioJobStage,
  type GraphPortfolioJobStatus,
  type GraphPortfolioJobView,
  StartGraphPortfolioSchema,
  type StartGraphPortfolioInput,
} from "@/lib/domain/graph-portfolio";
import { isProviderId, type ProviderId } from "@/lib/domain/providers";
import { createLlmClient, LlmPermanentError, type LlmClient, type LlmUsageContext } from "@/lib/llm";
import { withLlmDeadline } from "@/lib/llm/deadline";
import { notify } from "@/lib/notifications/service";
import { stageErrorMessage } from "@/lib/panel/runner";
import { resolveRequestedProvider } from "@/lib/providers/options";
import {
  assertProjectsInGraph,
  findOwnPosting,
  generateGraphPortfolio,
  loadOwnGraph,
  loadPortfolioMaterial,
  POSTING_NOT_FOUND_MESSAGE,
} from "./graph-material";
import { createGraphPortfolio, PORTFOLIO_NOT_FOUND, replacePortfolioText, type ReplacePortfolioTextResult } from "./service";

/** 라우트(POST /api/portfolios/graph, 다시 시도)의 maxDuration과 같아야 한다(라우트는 리터럴로 적는다). */
export const GRAPH_PORTFOLIO_ROUTE_MAX_DURATION_SEC = 300;
/** 자체 호스팅에서 한 번에 주는 시간(이력서 초안과 같다). */
export const SELF_HOSTED_GRAPH_PORTFOLIO_TIME_LIMIT_MS = 15 * 60_000;
/** 동시에 진행할 수 있는 작업 수(사용자당). */
export const MAX_ACTIVE_GRAPH_PORTFOLIO_JOBS = 2;
/** 끝난 작업을 남겨 두는 기간. */
export const GRAPH_PORTFOLIO_JOB_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** 보관함 목록에 실패한 작업을 보여 주는 기간. */
export const FAILED_GRAPH_PORTFOLIO_LIST_MS = 24 * 60 * 60_000;

export const GRAPH_PORTFOLIO_JOB_NOT_FOUND = "포트폴리오 작업을 찾을 수 없습니다.";
const STALE_ERROR = "포트폴리오 작업이 중간에 끊겼습니다(서버 재시작 또는 시간 제한). 다시 시도해 주세요.";

export function graphPortfolioTimeLimitMs(env: Record<string, string | undefined> = process.env): number {
  return env.VERCEL ? Math.max(30, GRAPH_PORTFOLIO_ROUTE_MAX_DURATION_SEC - 30) * 1000 : SELF_HOSTED_GRAPH_PORTFOLIO_TIME_LIMIT_MS;
}

export function graphPortfolioStaleMs(env: Record<string, string | undefined> = process.env): number {
  return graphPortfolioTimeLimitMs(env) + 60_000;
}

interface JobRow {
  id: string;
  userId: string;
  runId: string;
  status: string;
  stage: string;
  label: string;
  input: Prisma.JsonValue | null;
  provider: string | null;
  error: string | null;
  portfolioId: string | null;
  result: Prisma.JsonValue | null;
  attempts: number;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);

export function isGraphPortfolioJobStale(row: Pick<JobRow, "status" | "startedAt">, now: number = Date.now(), staleMs: number = graphPortfolioStaleMs()): boolean {
  return row.status === "running" && now - row.startedAt.getTime() > staleMs;
}

function parseInput(raw: unknown): StartGraphPortfolioInput | null {
  const parsed = StartGraphPortfolioSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function toGraphPortfolioJobView(row: JobRow): GraphPortfolioJobView {
  const status: GraphPortfolioJobStatus = (GRAPH_PORTFOLIO_JOB_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as GraphPortfolioJobStatus)
    : "failed";
  const stage: GraphPortfolioJobStage = (GRAPH_PORTFOLIO_JOB_STAGES as readonly string[]).includes(row.stage)
    ? (row.stage as GraphPortfolioJobStage)
    : "material";
  const result = (row.result ?? {}) as { notes?: unknown; missingInfo?: unknown; regenerate?: unknown };
  const input = parseInput(row.input);
  return {
    id: row.id,
    status,
    stage,
    label: row.label,
    error: row.error,
    portfolioId: row.portfolioId,
    regenerate: !!input?.portfolioId || result.regenerate === true,
    notes: strings(result.notes),
    missingInfo: strings(result.missingInfo),
    canRetry: status === "failed" && input !== null,
    attempts: row.attempts,
    startedAt: row.startedAt.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    completedAt: row.completedAt?.getTime() ?? null,
  };
}

async function countActive(userId: string, now: number, db: Prisma.TransactionClient = prisma): Promise<number> {
  return db.portfolioDraftJob.count({ where: { userId, status: "running", startedAt: { gt: new Date(now - graphPortfolioStaleMs()) } } });
}

async function assertCapacity(userId: string, now: number, db: Prisma.TransactionClient = prisma): Promise<void> {
  if ((await countActive(userId, now, db)) >= MAX_ACTIVE_GRAPH_PORTFOLIO_JOBS) {
    throw new FeatureError(
      `포트폴리오는 동시에 ${MAX_ACTIVE_GRAPH_PORTFOLIO_JOBS}개까지 만들 수 있습니다. 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.`,
      409,
    );
  }
}

async function lockJobs(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portfolio-draft:${userId}`}))`;
}

const REGENERATE_RUNNING = "이 포트폴리오를 이미 다시 만드는 중입니다. 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.";

/** 이 포트폴리오를 다시 만드는 진행 중(멈추지 않은) 작업. 없으면 null. exceptJobId는 빼고 센다(다시 시도하는 자기 자신). */
export async function findActiveRegenerateJob(
  userId: string,
  portfolioId: string,
  now: number = Date.now(),
  db: Prisma.TransactionClient = prisma,
  exceptJobId?: string,
): Promise<{ id: string } | null> {
  return db.portfolioDraftJob.findFirst({
    select: { id: true },
    where: {
      userId,
      portfolioId,
      status: "running",
      startedAt: { gt: new Date(now - graphPortfolioStaleMs()) },
      ...(exceptJobId ? { id: { not: exceptJobId } } : {}),
    },
    orderBy: { startedAt: "desc" },
  });
}

/** 다시 만들 대상: 내 'graph' 포트폴리오. 없으면 404, 그래프 포트폴리오가 아니면 409. */
async function assertRegenerateTarget(userId: string, portfolioId: string): Promise<{ title: string }> {
  const row = await prisma.portfolio.findFirst({ select: { kind: true, title: true }, where: { id: portfolioId, userId } });
  if (!row) throw new FeatureError(PORTFOLIO_NOT_FOUND, 404);
  if (row.kind !== "graph") throw new FeatureError("경험 그래프로 만든 포트폴리오만 다시 만들 수 있습니다.", 409);
  return { title: row.title };
}

export interface StartGraphPortfolioDeps {
  now?: () => number;
  resolveProvider?: (requested: string | null) => Promise<ProviderId>;
  /** 레이트 리밋(다른 확인 뒤에 부른다 — 잘못된 요청이 한도를 깎지 않게). */
  beforeCreate?: () => Promise<void>;
}

/**
 * 작업 시작: 입력·그래프(고른 프로젝트가 내 그래프에 있는지)·공고·다시 만들 대상·엔진·동시 작업 수를 확인하고 'running' 행을 만든다.
 */
export async function startGraphPortfolioJob(
  user: { id: string; name: string | null },
  input: StartGraphPortfolioInput,
  deps: StartGraphPortfolioDeps = {},
): Promise<{ job: GraphPortfolioJobView; runId: string; provider: ProviderId }> {
  const now = deps.now?.() ?? Date.now();
  const graph = await loadOwnGraph(user);
  assertProjectsInGraph(graph, input.projectIds);
  if (input.postingId && !(await findOwnPosting(user.id, input.postingId))) throw new FeatureError(POSTING_NOT_FOUND_MESSAGE, 404);
  const target = input.portfolioId ? await assertRegenerateTarget(user.id, input.portfolioId) : null;
  const provider = await (deps.resolveProvider ?? resolveRequestedProvider)(input.provider ?? null);
  await assertCapacity(user.id, now);
  await deps.beforeCreate?.();

  await prisma.portfolioDraftJob
    .deleteMany({ where: { userId: user.id, status: { not: "running" }, updatedAt: { lt: new Date(now - GRAPH_PORTFOLIO_JOB_RETENTION_MS) } } })
    .catch(() => undefined);

  const runId = nanoid();
  // 다시 만들기는 본문만 바꾸므로 본문 제목(label)도 보관함의 이름을 쓴다(입력한 이름은 무시 — 제목과 본문 H1이 어긋나지 않게).
  const label = (target?.title || input.title?.trim() || "경험 그래프 포트폴리오").slice(0, 120);
  const stored = { ...input, provider } satisfies StartGraphPortfolioInput;
  const row = await prisma.$transaction(async (tx) => {
    await lockJobs(tx, user.id);
    await assertCapacity(user.id, now, tx);
    // 같은 포트폴리오를 두 작업이 동시에 다시 만들면 늦게 끝난 쪽이 앞의 결과를 덮는다 — 하나만 허용한다.
    if (input.portfolioId && (await findActiveRegenerateJob(user.id, input.portfolioId, now, tx))) throw new FeatureError(REGENERATE_RUNNING, 409);
    return tx.portfolioDraftJob.create({
      data: {
        id: nanoid(16),
        userId: user.id,
        runId,
        status: "running",
        stage: "material",
        label: stripNul(label),
        input: stripNulDeep(stored) as Prisma.InputJsonValue,
        provider,
        portfolioId: input.portfolioId ?? null,
        startedAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    });
  });
  return { job: toGraphPortfolioJobView(row), runId, provider };
}

async function closeStale(row: JobRow, now: number): Promise<boolean> {
  const { count } = await prisma.portfolioDraftJob.updateMany({
    where: { id: row.id, runId: row.runId, status: "running" },
    data: { status: "failed", error: STALE_ERROR, updatedAt: new Date(now) },
  });
  if (count > 0) await notifyFailed(row.userId, row.id, row.label, STALE_ERROR);
  return count > 0;
}

/** 내 작업(멈춘 작업은 이때 실패로 닫는다). 남의 것이면 null. */
export async function getGraphPortfolioJob(userId: string, jobId: string, now: number = Date.now()): Promise<GraphPortfolioJobView | null> {
  let row = (await prisma.portfolioDraftJob.findFirst({ where: { id: jobId, userId } })) as JobRow | null;
  if (!row) return null;
  if (isGraphPortfolioJobStale(row, now) && (await closeStale(row, now))) {
    row = (await prisma.portfolioDraftJob.findFirst({ where: { id: jobId, userId } })) as JobRow | null;
    if (!row) return null;
  }
  return toGraphPortfolioJobView(row);
}

/** 이 사용자의 멈춘 작업을 실패로 닫고 알린다(알림 목록이 부른다). 닫은 개수. */
export async function sweepStaleGraphPortfolioJobs(userId: string, now: number = Date.now()): Promise<number> {
  const rows = (await prisma.portfolioDraftJob.findMany({
    where: { userId, status: "running", startedAt: { lt: new Date(now - graphPortfolioStaleMs()) } },
    take: 20,
  })) as JobRow[];
  let closed = 0;
  for (const row of rows) if (await closeStale(row, now)) closed++;
  return closed;
}

/** 보관함에 보일 작업: 진행 중 + 최근 하루 안에 실패한 것(최근 순). */
export async function listVisibleGraphPortfolioJobs(userId: string, now: number = Date.now()): Promise<GraphPortfolioJobView[]> {
  const rows = (await prisma.portfolioDraftJob.findMany({
    where: {
      userId,
      OR: [{ status: "running" }, { status: "failed", input: { not: Prisma.DbNull }, updatedAt: { gt: new Date(now - FAILED_GRAPH_PORTFOLIO_LIST_MS) } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
  })) as JobRow[];
  const out: GraphPortfolioJobView[] = [];
  for (const row of rows) {
    if (isGraphPortfolioJobStale(row, now) && (await closeStale(row, now))) out.push(toGraphPortfolioJobView({ ...row, status: "failed", error: STALE_ERROR }));
    else out.push(toGraphPortfolioJobView(row));
  }
  return out;
}

/** 다시 시도: 실패했거나 멈춘 작업을 새 runId로 처음부터. 남의 작업이면 null, 다시 시도할 수 없으면 409. */
export async function restartGraphPortfolioJob(
  userId: string,
  jobId: string,
  deps: { now?: () => number; beforeRestart?: () => Promise<void> } = {},
): Promise<{ job: GraphPortfolioJobView; runId: string; provider: ProviderId } | null> {
  const now = deps.now?.() ?? Date.now();
  const row = (await prisma.portfolioDraftJob.findFirst({ where: { id: jobId, userId } })) as JobRow | null;
  if (!row) return null;
  const stale = isGraphPortfolioJobStale(row, now);
  if (row.status === "running" && !stale) throw new FeatureError("포트폴리오를 쓰는 중입니다. 잠시 후 다시 확인해 주세요.", 409);
  if (row.status === "completed") throw new FeatureError("이미 완성된 포트폴리오입니다.", 409);
  const input = parseInput(row.input);
  if (!input) throw new FeatureError("다시 시도할 입력이 남아 있지 않습니다. 포트폴리오 화면에서 다시 만들어 주세요.", 409);
  const saved = row.provider && isProviderId(row.provider) ? row.provider : null;
  const provider = await resolveRequestedProvider(saved).catch(() => resolveRequestedProvider(null));
  await assertCapacity(userId, now);
  await deps.beforeRestart?.();
  const runId = nanoid();
  const updated = await prisma.$transaction(async (tx) => {
    await lockJobs(tx, userId);
    await assertCapacity(userId, now, tx);
    if (input.portfolioId && (await findActiveRegenerateJob(userId, input.portfolioId, now, tx, jobId))) throw new FeatureError(REGENERATE_RUNNING, 409);
    const [next] = await tx.portfolioDraftJob.updateManyAndReturn({
      where: { id: jobId, userId, runId: row.runId, status: row.status },
      data: { runId, status: "running", stage: "material", error: null, provider, attempts: { increment: 1 }, startedAt: new Date(now), updatedAt: new Date(now) },
    });
    return next;
  });
  if (!updated) throw new FeatureError("다른 요청이 먼저 이 작업을 다시 시작했습니다. 새로고침해 주세요.", 409);
  return { job: toGraphPortfolioJobView(updated), runId, provider };
}

export function graphPortfolioErrorMessage(err: unknown): string {
  if (err instanceof FeatureError) return err.message;
  if (err instanceof LlmPermanentError) return `포트폴리오를 만들지 못했습니다. ${stageErrorMessage(err).replace("이 단계의 ", "")}`;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "포트폴리오를 만드는 데 시간이 너무 오래 걸려 중단했습니다. 프로젝트 수를 줄여 다시 시도해 주세요.";
  }
  return "포트폴리오를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function notifyFailed(userId: string, jobId: string, label: string, error: string): Promise<void> {
  return notify(userId, {
    kind: "portfolio-draft-failed",
    title: "경험 그래프 포트폴리오를 만들지 못했습니다",
    body: `${label} — ${error}`,
    link: `/app/portfolios/drafts/${jobId}`,
  });
}

export interface RunGraphPortfolioDeps {
  createClient?: (provider: ProviderId, usage: LlmUsageContext) => LlmClient;
  timeLimitMs?: number;
  now?: () => number;
}

class SupersededError extends Error {}

/**
 * 이 실행(runId)을 맡는다: 아직 아무도 이 runId를 맡지 않았을 때만 result에 { claimRunId, runner }를 적는다(조건부 UPDATE, 1행이면 이김).
 * 작업 행은 처음부터 'running'이라 status만으로는 Vercel(after)과 Python 워커(worker/app/jobs/portfolio_graph.py)가 같은 runId를
 * 함께 실행할 수 있다(워커가 받았는데 응답이 디스패치 타임아웃을 넘긴 경우 등). 두 쪽이 같은 SQL로 맡기 때문에 한쪽만 실행한다.
 * 다시 시도는 새 runId를 쓰므로 남은 claim 표시와 상관없이 다시 맡을 수 있다. 완료 기록은 result를 통째로 바꾸므로 표시가 남지 않는다.
 */
export async function claimGraphPortfolioRun(userId: string, jobId: string, runId: string, runner: "vercel" | "worker" = "vercel"): Promise<boolean> {
  const count = await prisma.$executeRaw`
    UPDATE portfolio_draft_jobs
       SET result = jsonb_build_object('claimRunId', run_id, 'runner', ${runner}::text)
     WHERE id = ${jobId} AND user_id = ${userId} AND run_id = ${runId} AND status = 'running'
       AND (result IS NULL OR result->>'claimRunId' IS DISTINCT FROM run_id)`;
  return count > 0;
}

async function discardPortfolio(userId: string, portfolioId: string): Promise<void> {
  try {
    const { deletePortfolio } = await import("./service");
    await deletePortfolio(userId, portfolioId);
  } catch (err) {
    console.error("[graph portfolio] 버려진 포트폴리오 삭제 실패", portfolioId, err);
  }
}

/**
 * 백그라운드 실행(after()). 던지지 않는다. 이미 끝났거나 runId가 바뀌었으면 아무것도 쓰지 않는다.
 * 새로 만들기는 저장 뒤 완료 기록이 실패하면(멈춤 판정·다시 시도) 만든 포트폴리오를 지운다. 다시 만들기는 본문 바꾸기와 완료 기록을
 * 한 트랜잭션에서 해서, 완료 기록이 실패하면 본문도 그대로 둔다.
 */
export async function runGraphPortfolioJob(
  userId: string,
  jobId: string,
  runId: string,
  provider: ProviderId,
  deps: RunGraphPortfolioDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const mine = { id: jobId, userId, runId, status: "running" } satisfies Prisma.PortfolioDraftJobWhereInput;
  const setStage = async (stage: GraphPortfolioJobStage) => {
    const { count } = await prisma.portfolioDraftJob.updateMany({ where: mine, data: { stage, updatedAt: new Date(now()) } });
    if (count === 0) throw new SupersededError();
  };
  let label = "경험 그래프 포트폴리오";
  let createdId: string | null = null;
  try {
    const row = (await prisma.portfolioDraftJob.findFirst({ where: mine })) as JobRow | null;
    if (!row) return;
    // 워커가 이미 맡았으면(또는 같은 runId를 다른 실행이 맡았으면) 아무것도 쓰지 않는다.
    if (!(await claimGraphPortfolioRun(userId, jobId, runId))) return;
    label = row.label;
    const input = parseInput(row.input);
    if (!input) throw new FeatureError("작업 입력을 읽지 못했습니다. 포트폴리오 화면에서 다시 만들어 주세요.", 400);
    const user = await prisma.user.findUnique({ select: { id: true, name: true }, where: { id: userId } });
    if (!user) return;

    const material = await loadPortfolioMaterial(user, input);
    await setStage("writing");

    const client = (deps.createClient ?? createLlmClient)(provider, { userId, referenceId: jobId });
    const limitMs = deps.timeLimitMs ?? graphPortfolioTimeLimitMs();
    const timeLimitMs = Math.min(limitMs, Math.max(1_000, row.startedAt.getTime() + limitMs - now()));
    const output = await withLlmDeadline(
      undefined,
      (signal) => generateGraphPortfolio(client, material, { title: label, notes: input.notes, templateId: input.templateId }, signal),
      { timeoutMs: timeLimitMs, message: "포트폴리오를 만드는 데 시간이 너무 오래 걸려 중단했습니다. 프로젝트 수를 줄여 다시 시도해 주세요." },
    );
    await setStage("saving");

    const text = graphPortfolioToMarkdown(output, {
      title: label,
      personName: material.personName,
      links: material.links,
      contactLinks: material.contactLinks,
      templateId: input.templateId,
    });
    const source = {
      projectIds: input.projectIds,
      // 그사이 공고가 지워졌으면 공고 없이 만든 것으로 남긴다.
      postingId: material.posting ? (input.postingId ?? null) : null,
      notes: input.notes ?? "",
      templateId: input.templateId,
      missingInfo: output.missingInfo,
      generatedAt: now(),
    };
    const complete = (portfolioId: string) => ({
      where: mine,
      data: {
        status: "completed",
        stage: "saving",
        error: null,
        portfolioId,
        result: stripNulDeep({ notes: output.notes, missingInfo: output.missingInfo, regenerate: !!input.portfolioId }) as Prisma.InputJsonValue,
        input: Prisma.DbNull,
        completedAt: new Date(now()),
        updatedAt: new Date(now()),
      },
    });
    let portfolioId: string;
    if (input.portfolioId) {
      // 다시 만들기: 본문 바꾸기와 완료 기록을 한 트랜잭션에서 한다. 그사이 이 작업이 멈춤 판정·다시 시도로 버려졌으면(완료 기록이 0행)
      // 본문 바꾸기까지 되돌린다 — '실패' 알림인데 본문만 바뀌거나, 다시 시도가 본문을 또 덮는 일이 없게.
      const target = input.portfolioId;
      const replaced: ReplacePortfolioTextResult = await replacePortfolioText(userId, target, text, {
        source,
        commit: async (tx) => (await tx.portfolioDraftJob.updateMany(complete(target))).count > 0,
      });
      if (replaced === "aborted") return;
      if (replaced === null) throw new FeatureError("다시 만들 포트폴리오가 지워졌습니다. 보관함에서 새로 만들어 주세요.", 404);
      if (replaced === "not_graph") throw new FeatureError("포트폴리오 내용이 파일·링크로 바뀌어 다시 만들지 않았습니다.", 409);
      if (replaced === "conflict") throw new FeatureError("그사이 포트폴리오 본문이 다른 저장으로 바뀌어 덮어쓰지 않았습니다. 다시 시도해 주세요.", 409);
      portfolioId = replaced.portfolio.id;
    } else {
      const created = await createGraphPortfolio(userId, { title: label, text, source });
      portfolioId = created.portfolio.id;
      createdId = portfolioId;
      const { count } = await prisma.portfolioDraftJob.updateMany(complete(portfolioId));
      if (count === 0) {
        await discardPortfolio(userId, createdId);
        return;
      }
      createdId = null;
    }
    await notify(userId, {
      kind: "portfolio-draft-completed",
      title: input.portfolioId ? "포트폴리오를 다시 만들었습니다" : "경험 그래프 포트폴리오가 완성됐습니다",
      body: output.missingInfo.length > 0 ? `${label} — 채워야 할 정보 ${output.missingInfo.length}개` : label,
      link: `/app/portfolios/${portfolioId}`,
    });
  } catch (err) {
    if (createdId) await discardPortfolio(userId, createdId);
    if (err instanceof SupersededError) return;
    if (!(err instanceof LlmPermanentError) && !(err instanceof FeatureError)) console.error("[graph portfolio]", jobId, err);
    const message = graphPortfolioErrorMessage(err);
    const { count } = await prisma.portfolioDraftJob
      .updateMany({ where: mine, data: { status: "failed", error: stripNul(message), updatedAt: new Date(now()) } })
      .catch(() => ({ count: 0 }));
    if (count > 0) await notifyFailed(userId, jobId, label, message);
  }
}

/**
 * 본문 직접 고치기(PUT /api/portfolios/[id]/text). 이 포트폴리오를 다시 만드는 작업이 진행 중이면 409 — 저장해도 작업이 끝나며 덮어쓰므로.
 * 확인은 본문 바꾸기와 같은 트랜잭션 안에서 한다(행을 바꾼 뒤 세므로, 동시에 끝나는 다시 만들기와는 compare-and-swap이 한쪽을 막는다).
 */
export async function saveGraphPortfolioText(
  userId: string,
  portfolioId: string,
  text: string,
  now: number = Date.now(),
): Promise<Exclude<ReplacePortfolioTextResult, "conflict" | "aborted">> {
  const saved = await replacePortfolioText(userId, portfolioId, text, {
    commit: async (tx) => !(await findActiveRegenerateJob(userId, portfolioId, now, tx)),
  });
  if (saved === "aborted") throw new FeatureError("이 포트폴리오를 다시 만드는 중이라 저장하지 않았습니다. 다시 만들기가 끝난 뒤 고쳐 주세요.", 409);
  if (saved === "conflict") throw new FeatureError("그사이 본문이 다른 저장으로 바뀌었습니다. 새로고침한 뒤 다시 고쳐 주세요.", 409);
  return saved;
}
