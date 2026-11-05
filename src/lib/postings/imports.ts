import "server-only";
/**
 * 공고 URL 가져오기 작업(posting_imports). 라우트가 작업 행(queued)을 만들고 after()로 runImport를 예약하면,
 * 화면은 GET /api/postings/import/[jobId]를 폴링한다.
 * - 한 번만 실행: runImport는 조건부 UPDATE(queued → reading, attempts+1)로 작업을 차지하고, 이후 모든 쓰기를
 *   '같은 attempts·진행 중 상태'일 때만 반영한다(동시 호출·멈춘 실행의 늦은 쓰기 방지).
 * - 멈춘 작업: reading/analyzing·queued인 채로 5분 넘게 갱신이 없으면(프로세스 종료) 조회 시 다시 실행한다.
 *   실행 1회는 180초 상한이라 정상 실행이 멈춤으로 오판되지 않는다. 3회 시도 뒤에도 멈추면 실패로 닫는다.
 * - 오류는 사용자용 문구만 저장한다(내부 주소·원본 오류 메시지는 로그에만).
 * CareerLoop(src/server/postingImport/jobs.ts)에서 가져옴 — 원본은 프로세스 메모리 Map으로 중복 실행을 막아 여러 인스턴스·재시작에서 새었다.
 */
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { PostingImportRow } from "@/lib/db/types";
import { DAILY_POSTING_IMPORT_LIMIT, type PostingImportJob, type PostingImportStatus } from "@/lib/domain/postings";
import type { ProviderId } from "@/lib/domain/providers";
import { createLlmClient, LlmPermanentError, type LlmClient } from "@/lib/llm";
import { ProviderServiceError } from "@/lib/providers/errors";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { extractPosting, PostingExtractError } from "./extract";
import { fetchPostingPage, PostingFetchError, type FetchDeps } from "./fetch";
import { postingPageText } from "./page-text";
import { createPosting, DuplicatePostingError, findPostingIdByUrl } from "./service";
import { normalizeUrl, parsePostingUrl, PostingUrlError } from "./url";

/** 실행 1회 전체 상한(페이지 읽기 + AI 분석). */
export const IMPORT_TIME_LIMIT_MS = 180_000;
/** 이만큼 갱신이 없으면 실행이 죽은 것으로 본다(IMPORT_TIME_LIMIT_MS보다 넉넉히). */
export const IMPORT_STALE_MS = 5 * 60_000;
export const MAX_IMPORT_ATTEMPTS = 3;
/** 사용자당 동시에 진행할 수 있는 가져오기. */
export const MAX_ACTIVE_IMPORTS = 3;

const ACTIVE: PostingImportStatus[] = ["queued", "reading", "analyzing"];
const GENERIC_ERROR = "공고를 가져오지 못했습니다. 링크와 AI 연결 상태를 확인한 뒤 다시 시도하세요.";
const TIMEOUT_ERROR = "공고 분석 시간이 초과됐습니다. 잠시 후 다시 시도하세요.";
const STALE_ERROR = "공고 가져오기가 중간에 끊겼습니다. 다시 시도해 주세요.";

export function toImportJob(row: PostingImportRow): PostingImportJob {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    error: row.error ?? null,
    postingId: row.postingId ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** 진행 중인데 오래 갱신되지 않은 작업(조회 시 다시 실행할 대상). */
export function isImportStale(job: Pick<PostingImportJob, "status" | "updatedAt">, now = Date.now()): boolean {
  return (job.status === "queued" || job.status === "reading" || job.status === "analyzing") && now - job.updatedAt > IMPORT_STALE_MS;
}

/**
 * 가져오기 작업을 만든다(실행은 호출자가 after()로 runImport를 예약). 이미 보관한 URL → DuplicatePostingError(409),
 * 같은 URL이 진행 중이면 그 작업을 돌려준다(reused). 동시 진행 3건(409)·최근 24시간 20건(429) 제한.
 */
export async function createImport(userId: string, rawUrl: string, now = Date.now()): Promise<{ job: PostingImportJob; reused: boolean }> {
  let url: string;
  try {
    url = parsePostingUrl(rawUrl).href;
  } catch (err) {
    if (err instanceof PostingUrlError) throw new FeatureError(err.message, 400);
    throw err;
  }
  const existing = await findPostingIdByUrl(userId, url);
  if (existing) throw new DuplicatePostingError(existing);

  return prisma.$transaction(async (tx) => {
    // 같은 사용자의 가져오기 생성을 직렬화한다(READ COMMITTED에서는 개수 확인과 삽입 사이에 다른 요청이 끼어들 수 있다).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`posting-import:${userId}`}))`;
    const active = (await tx.postingImport.findMany({ where: { userId, status: { in: ACTIVE } } })) as PostingImportRow[];
    // 같은 공고(www·추적 파라미터·끝 슬래시만 다른 링크 포함)를 진행 중이면 그 작업을 재사용한다.
    const key = normalizeUrl(url);
    const same = active.find((r) => normalizeUrl(r.url) === key && !isImportStale(toImportJob(r), now));
    if (same) return { job: toImportJob(same), reused: true };
    if (active.filter((r) => !isImportStale(toImportJob(r), now)).length >= MAX_ACTIVE_IMPORTS) {
      throw new FeatureError("진행 중인 공고 가져오기가 많습니다. 끝난 뒤 다시 시도하세요.", 409);
    }
    const recent = await tx.postingImport.count({ where: { userId, createdAt: { gte: new Date(now - 86_400_000) } } });
    if (recent >= DAILY_POSTING_IMPORT_LIMIT) {
      throw new FeatureError(
        `공고 링크 가져오기는 하루 ${DAILY_POSTING_IMPORT_LIMIT}번까지 할 수 있습니다. 직접 입력으로 추가하거나 내일 다시 시도하세요.`,
        429,
      );
    }
    const at = new Date(now);
    const row = await tx.postingImport.create({
      data: { id: nanoid(), userId, url: stripNul(url), status: "queued", createdAt: at, updatedAt: at },
    });
    return { job: toImportJob(row as PostingImportRow), reused: false };
  });
}

export async function getImport(userId: string, id: string): Promise<PostingImportJob | null> {
  const row = await prisma.postingImport.findFirst({ where: { id, userId } });
  return row ? toImportJob(row as PostingImportRow) : null;
}

/** 최근 24시간의 가져오기 작업(최신 순). 목록 화면이 새로 열려도 진행 상황을 이어 보여 준다. */
export async function listRecentImports(userId: string, opts: { limit?: number; now?: number } = {}): Promise<PostingImportJob[]> {
  const now = opts.now ?? Date.now();
  const rows = await prisma.postingImport.findMany({
    where: { userId, createdAt: { gte: new Date(now - 86_400_000) } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: opts.limit ?? 10,
  });
  return (rows as PostingImportRow[]).map(toImportJob);
}

class ImportTimeoutError extends Error {
  constructor() {
    super("import timeout");
    this.name = "ImportTimeoutError";
  }
}

const LLM_ERROR_MESSAGES: Partial<Record<LlmPermanentError["reason"], string>> = {
  refusal: "AI 모델이 이 공고 분석을 거절했습니다. 직접 입력으로 추가해 주세요.",
  invalid_output: "AI 분석 결과 형식을 확인하지 못했습니다. 다시 시도하세요.",
  auth: "AI 계정 로그인이 없거나 만료되었습니다. 'AI 연결' 화면에서 다시 로그인한 뒤 재시도해 주세요.",
  usage_limit: "연결된 AI 계정의 사용량 한도에 걸렸습니다. 한도가 풀린 뒤 다시 시도해 주세요.",
  unavailable: "지금 쓸 수 있는 AI 엔진이 없습니다. 'AI 연결' 화면을 확인해 주세요.",
  timeout: TIMEOUT_ERROR,
};

/** 사용자에게 보여도 되는 오류 문구. 그 밖의 오류(네트워크 원문·내부 주소 등)는 로그에만 남기고 일반 문구로 바꾼다. */
function safeImportError(err: unknown, timedOut: boolean): string {
  if (timedOut) return TIMEOUT_ERROR;
  if (err instanceof PostingFetchError || err instanceof PostingExtractError || err instanceof PostingUrlError) return err.message;
  if (err instanceof FeatureError || err instanceof ProviderServiceError) return err.message;
  if (err instanceof LlmPermanentError) return LLM_ERROR_MESSAGES[err.reason] ?? GENERIC_ERROR;
  console.error("[runImport]", err);
  return GENERIC_ERROR;
}

export interface RunImportDeps {
  /** 테스트용: 엔진 선택 없이 이 클라이언트를 쓴다. */
  llm?: LlmClient;
  /** 엔진(라우트가 요청 시점에 검증한 값). 없으면 실행 시점의 기본 엔진. */
  provider?: ProviderId;
  /** 테스트용: 페이지 가져오기를 바꾼다(실제 인터넷에 접속하지 않게). */
  fetchPage?: (url: string, opts: { signal: AbortSignal }) => Promise<{ url: string; html: string }>;
  fetchDeps?: Omit<FetchDeps, "signal">;
  timeLimitMs?: number;
  now?: () => number;
}

/**
 * 작업 하나를 끝까지 실행한다(예외를 밖으로 던지지 않는다). 이미 끝났거나 다른 실행이 차지했으면 아무것도 하지 않는다.
 * 멈춘 작업(isImportStale)은 다시 차지해 처음부터 실행한다. 시도 횟수를 넘긴 멈춘 작업은 실패로 닫는다.
 */
export async function runImport(importId: string, deps: RunImportDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  const staleBefore = new Date(now() - IMPORT_STALE_MS);
  const [claimed] = await prisma.postingImport.updateManyAndReturn({
    where: {
      id: importId,
      attempts: { lt: MAX_IMPORT_ATTEMPTS },
      OR: [{ status: "queued" }, { status: { in: ["reading", "analyzing"] }, updatedAt: { lt: staleBefore } }],
    },
    data: { status: "reading", error: null, attempts: { increment: 1 }, updatedAt: new Date(now()) },
  });
  if (!claimed) {
    // 시도를 다 쓴 멈춘 작업은 실패로 닫는다(계속 '진행 중'으로 남지 않게).
    await prisma.postingImport.updateMany({
      where: {
        id: importId,
        attempts: { gte: MAX_IMPORT_ATTEMPTS },
        status: { in: ACTIVE },
        updatedAt: { lt: staleBefore },
      },
      data: { status: "failed", error: STALE_ERROR, updatedAt: new Date(now()) },
    });
    return;
  }

  const owned: Prisma.PostingImportWhereInput = { id: importId, attempts: claimed.attempts, status: { in: ACTIVE } };
  const write = async (patch: Prisma.PostingImportUncheckedUpdateManyInput): Promise<boolean> => {
    const { count } = await prisma.postingImport.updateMany({
      where: owned,
      data: { ...patch, ...(typeof patch.error === "string" ? { error: stripNul(patch.error) } : {}), updatedAt: new Date(now()) },
    });
    return count > 0;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ImportTimeoutError()), deps.timeLimitMs ?? IMPORT_TIME_LIMIT_MS);
  const signal = controller.signal;
  try {
    const page = deps.fetchPage
      ? await deps.fetchPage(claimed.url, { signal })
      : await fetchPostingPage(claimed.url, { ...deps.fetchDeps, signal });
    signal.throwIfAborted();
    if (!(await write({ status: "analyzing" }))) return;

    const provider = deps.llm ? null : (deps.provider ?? (await resolveRequestedProvider(null)));
    const llm = deps.llm ?? createLlmClient(provider!);
    const { posting } = await extractPosting({ url: page.url, pageText: postingPageText(page.html) }, llm, { signal });
    signal.throwIfAborted();
    const created = await createPosting(claimed.userId, posting, { extractedBy: provider ?? llm.name });
    await write({ status: "completed", postingId: created.id, error: null });
  } catch (err) {
    if (err instanceof DuplicatePostingError) {
      // 리다이렉트 뒤 최종 주소가 이미 보관한 공고와 같은 경우. 기존 공고로 안내한다.
      await write({ status: "failed", error: err.message, postingId: err.existingId });
      return;
    }
    await write({ status: "failed", error: safeImportError(err, signal.reason instanceof ImportTimeoutError) });
  } finally {
    clearTimeout(timer);
  }
}
