import "server-only";
/**
 * 공고 URL 가져오기 작업(posting_imports). 라우트가 작업 행(queued)을 만들고 after()로 runImport를 예약하면,
 * 화면은 GET /api/postings/import/[jobId]를 폴링한다.
 * - 한 번만 실행: runImport는 조건부 UPDATE(queued → reading, attempts+1)로 작업을 차지하고, 이후 모든 쓰기를
 *   '같은 attempts·진행 중 상태'일 때만 반영한다(동시 호출·멈춘 실행의 늦은 쓰기 방지).
 * - 멈춘 작업: reading/analyzing·queued인 채로 5분 넘게 갱신이 없으면(프로세스 종료) 조회 시 다시 실행한다.
 *   실행 1회는 180초 상한이라 정상 실행이 멈춤으로 오판되지 않는다. 3회 시도 뒤에도 멈추면 실패로 닫는다.
 * - 오류는 사용자용 문구만 저장한다(내부 주소·원본 오류 메시지는 로그에만).
 * - 공고 찾기: 결과는 공용 공고(shared_postings)에도 저장하고, 같은 URL을 다시 가져오면 공용 공고를 바로 담는다(shared.ts).
 * CareerLoop(src/server/postingImport/jobs.ts)에서 가져옴 — 원본은 프로세스 메모리 Map으로 중복 실행을 막아 여러 인스턴스·재시작에서 새었다.
 */
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { PostingImportRow, SharedPostingRow } from "@/lib/db/types";
import { DAILY_POSTING_IMPORT_LIMIT, type PostingImportJob, type PostingImportStatus } from "@/lib/domain/postings";
import type { ProviderId } from "@/lib/domain/providers";
import { hitDbLimit, POSTING_CAPTURE_TARGET_LIMIT } from "@/lib/auth/db-rate-limit";
import { createLlmClient, type LlmClient } from "@/lib/llm";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { runPostingCapture, type CaptureDeps } from "./capture";
import { requestCapture } from "./capture-store";
import { extractPosting } from "./extract";
import { fetchPostingPage, type FetchDeps } from "./fetch";
import { safePostingAiError } from "./http";
import { postingPageText } from "./page-text";
import { createPosting, DuplicatePostingError, findPostingIdByUrl } from "./service";
import { findSharedPostingByUrlKey, refreshSharedImporterCount, saveSharedToLibrary, syncPostingFromShared, upsertSharedPosting } from "./shared";
import { normalizeUrl, parsePostingUrl, PostingUrlError } from "./url";

/** 실행 1회 전체 상한(페이지 읽기 + AI 분석). */
export const IMPORT_TIME_LIMIT_MS = 180_000;
/** 이만큼 갱신이 없으면 실행이 죽은 것으로 본다(IMPORT_TIME_LIMIT_MS보다 넉넉히). */
export const IMPORT_STALE_MS = 5 * 60_000;
export const MAX_IMPORT_ATTEMPTS = 3;
/** 사용자당 동시에 진행할 수 있는 가져오기. */
export const MAX_ACTIVE_IMPORTS = 3;

const ACTIVE: PostingImportStatus[] = ["queued", "reading", "analyzing"];
const STALE_ERROR = "공고 가져오기가 중간에 끊겼습니다. 다시 시도해 주세요.";

export function toImportJob(row: PostingImportRow): PostingImportJob {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    error: row.error ?? null,
    postingId: row.postingId ?? null,
    sharedPostingId: row.sharedPostingId ?? null,
    refresh: row.refresh,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** 진행 중인데 오래 갱신되지 않은 작업(조회 시 다시 실행할 대상). */
export function isImportStale(job: Pick<PostingImportJob, "status" | "updatedAt">, now = Date.now()): boolean {
  return (job.status === "queued" || job.status === "reading" || job.status === "analyzing") && now - job.updatedAt > IMPORT_STALE_MS;
}

export interface CreateImportOptions {
  /** '다시 가져오기': 공용 공고가 있어도 페이지를 다시 읽는다. 내 보관함에 같은 URL이 있으면 409 대신 그 공고를 새 내용으로 맞춘다. */
  refresh?: boolean;
  now?: number;
}

export interface CreateImportResult {
  job: PostingImportJob;
  /** 같은 URL을 진행 중인 작업을 돌려줬다(새로 실행할 필요 없음). */
  reused: boolean;
  /** 공고 찾기(공용 공고)에 있던 공고를 페이지·AI 없이 바로 담았다(job은 이미 completed). */
  fromShared: boolean;
}

/**
 * 가져오기 작업을 만든다(실행은 호출자가 after()로 runImport를 예약 — reused·fromShared면 예약하지 않는다).
 * - 이미 보관한 URL → DuplicatePostingError(409, existingId). refresh면 그 공고를 다시 가져오는 작업을 만든다.
 * - 공고 찾기에 같은 url_key가 있으면(refresh 아님) saveSharedToLibrary로 바로 담고 completed 작업 행을 남긴다
 *   (LLM·페이지 읽기 없음, 하루 횟수에 세지 않는다).
 * - 같은 URL이 진행 중이면 그 작업을 돌려준다(reused). 동시 진행 3건(409)·최근 24시간 20건(429) 제한.
 */
export async function createImport(userId: string, rawUrl: string, opts: CreateImportOptions = {}): Promise<CreateImportResult> {
  const now = opts.now ?? Date.now();
  const refresh = opts.refresh ?? false;
  let url: string;
  try {
    url = parsePostingUrl(rawUrl).href;
  } catch (err) {
    if (err instanceof PostingUrlError) throw new FeatureError(err.message, 400);
    throw err;
  }
  const key = normalizeUrl(url);
  // 입력 주소가 리다이렉트(중계·단축 링크)라 공용 공고의 url_key(최종 주소)와 다르면, 예전에 같은 입력 주소로 끝난 가져오기가 남긴
  // 공용 공고(별칭)로 찾는다 — 페이지 읽기·LLM 없이 재사용하고, 내 공고 중복도 그 공용 공고 연결로 알아본다.
  const shared = (await findSharedPostingByUrlKey(key)) ?? (await findSharedPostingByAlias(key));
  const existing = (await findPostingIdByUrl(userId, url)) ?? (shared ? await findPostingIdByShared(userId, shared.id) : null);
  if (existing && !refresh) throw new DuplicatePostingError(existing);

  if (!refresh) {
    if (shared) {
      const { posting } = await saveSharedToLibrary(userId, shared.id);
      const at = new Date(now);
      const row = await prisma.postingImport.create({
        data: {
          id: nanoid(),
          userId,
          url: stripNul(url),
          urlKey: stripNul(key),
          status: "completed",
          postingId: posting.id,
          sharedPostingId: shared.id,
          createdAt: at,
          updatedAt: at,
        },
      });
      return { job: toImportJob(row as PostingImportRow), reused: false, fromShared: true };
    }
  }

  return prisma.$transaction(async (tx) => {
    // 같은 사용자의 가져오기 생성을 직렬화한다(READ COMMITTED에서는 개수 확인과 삽입 사이에 다른 요청이 끼어들 수 있다).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`posting-import:${userId}`}))`;
    const active = (await tx.postingImport.findMany({ where: { userId, status: { in: ACTIVE } } })) as PostingImportRow[];
    // 같은 공고(www·추적 파라미터·끝 슬래시만 다른 링크 포함)를 진행 중이면 그 작업을 재사용한다.
    const same = active.find((r) => (r.urlKey ?? normalizeUrl(r.url)) === key && !isImportStale(toImportJob(r), now));
    if (same) return { job: toImportJob(same), reused: true, fromShared: false };
    if (active.filter((r) => !isImportStale(toImportJob(r), now)).length >= MAX_ACTIVE_IMPORTS) {
      throw new FeatureError("진행 중인 공고 가져오기가 많습니다. 끝난 뒤 다시 시도하세요.", 409);
    }
    // 공용 공고를 바로 담은 행(실행 없이 completed, attempts 0)은 세지 않는다.
    const recent = await tx.postingImport.count({
      where: { userId, createdAt: { gte: new Date(now - 86_400_000) }, NOT: { status: "completed", attempts: 0 } },
    });
    if (recent >= DAILY_POSTING_IMPORT_LIMIT) {
      throw new FeatureError(
        `공고 링크 가져오기는 하루 ${DAILY_POSTING_IMPORT_LIMIT}번까지 할 수 있습니다. 직접 입력으로 추가하거나 내일 다시 시도하세요.`,
        429,
      );
    }
    const at = new Date(now);
    const row = await tx.postingImport.create({
      data: {
        id: nanoid(),
        userId,
        url: stripNul(url),
        urlKey: stripNul(key),
        status: "queued",
        refresh,
        // 다시 가져오기: 결과를 이 공고에 맞춘다(runImport).
        postingId: refresh ? existing : null,
        createdAt: at,
        updatedAt: at,
      },
    });
    return { job: toImportJob(row as PostingImportRow), reused: false, fromShared: false };
  });
}

/** 같은 입력 주소(url_key)로 끝난 가져오기 작업이 남긴 공용 공고(숨김 제외) — 리다이렉트 링크의 별칭. */
async function findSharedPostingByAlias(urlKey: string): Promise<SharedPostingRow | null> {
  if (!urlKey) return null;
  const hit = await prisma.postingImport.findFirst({
    select: { sharedPosting: true },
    where: { urlKey, status: "completed", sharedPostingId: { not: null }, sharedPosting: { is: { hiddenAt: null } } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  return (hit?.sharedPosting as SharedPostingRow | null | undefined) ?? null;
}

/** 이 공용 공고에 연결된 내 공고(가장 오래된 것). */
async function findPostingIdByShared(userId: string, sharedId: string): Promise<string | null> {
  const row = await prisma.jobPosting.findFirst({ select: { id: true }, where: { userId, sharedPostingId: sharedId }, orderBy: { createdAt: "asc" } });
  return row?.id ?? null;
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

/**
 * 다시 가져오기: 내 공고를 공용 공고에 연결하고 그 내용으로 맞춘다(상태·메모는 그대로). 그 사이 공고를 지웠으면 null(새로 만든다).
 */
async function refreshOwnPosting(userId: string, postingId: string, sharedId: string): Promise<string | null> {
  const { count } = await prisma.jobPosting.updateMany({ where: { id: postingId, userId }, data: { sharedPostingId: sharedId } });
  if (count === 0) return null;
  const synced = await syncPostingFromShared(userId, postingId);
  return synced?.id ?? null;
}

class ImportTimeoutError extends Error {
  constructor() {
    super("import timeout");
    this.name = "ImportTimeoutError";
  }
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

    // 리다이렉트 뒤 최종 주소로 다시 확인한다(입력 주소로는 못 찾은 경우) — AI 분석 전에 끝내 비용을 쓰지 않는다.
    if (!claimed.refresh) {
      const finalShared = await findSharedPostingByUrlKey(normalizeUrl(page.url));
      if (finalShared) {
        // 공고 찾기에 이미 있으면 바로 담는다(이미 보관한 같은 공고면 그 공고를 연결해 돌려준다).
        const { posting } = await saveSharedToLibrary(claimed.userId, finalShared.id);
        await write({ status: "completed", postingId: posting.id, sharedPostingId: finalShared.id, error: null });
        return;
      }
      const dup = await findPostingIdByUrl(claimed.userId, page.url);
      if (dup) throw new DuplicatePostingError(dup);
    }

    if (!(await write({ status: "analyzing" }))) return;

    const provider = deps.llm ? null : (deps.provider ?? (await resolveRequestedProvider(null)));
    const llm = deps.llm ?? createLlmClient(provider!);
    const { posting, structure, sourceText } = await extractPosting({ url: page.url, pageText: postingPageText(page.html) }, llm, { signal });
    signal.throwIfAborted();
    const extractedBy = provider ?? llm.name;
    // 공고 찾기(공용 공고)에 저장한다 — 페이지에서 뽑은 값만(상태·메모는 개인 값이라 넣지 않는다).
    const shared = await upsertSharedPosting({ url: page.url, posting, structure, sourceText, extractedBy, createdBy: claimed.userId });
    // 다시 가져오기: 작업에 실린 내 공고, 없으면(리다이렉트 전 주소로 연 경우) 최종 주소·공용 공고로 찾은 내 공고를 갱신한다.
    const ownId = claimed.refresh
      ? (claimed.postingId ?? (await findPostingIdByUrl(claimed.userId, page.url)) ?? (await findPostingIdByShared(claimed.userId, shared.id)))
      : null;
    const synced = ownId ? await refreshOwnPosting(claimed.userId, ownId, shared.id) : null;
    const postingId =
      synced ?? (await createPosting(claimed.userId, posting, { extractedBy, structure, sourceText, sharedPostingId: shared.id })).id;
    await refreshSharedImporterCount(shared.id);
    await write({ status: "completed", postingId, sharedPostingId: shared.id, error: null });
  } catch (err) {
    if (err instanceof DuplicatePostingError) {
      // 리다이렉트 뒤 최종 주소가 이미 보관한 공고와 같은 경우. 기존 공고로 안내한다.
      await write({ status: "failed", error: err.message, postingId: err.existingId });
      return;
    }
    await write({ status: "failed", error: safePostingAiError(err, { timedOut: signal.reason instanceof ImportTimeoutError, context: "runImport" }) });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 원문 캡처 예약(가져오기를 막지 않는다 — 가져오기가 끝난 뒤 같은 after() 안에서 이어서 찍는다)
// ---------------------------------------------------------------------------

/**
 * 끝난 가져오기의 공용 공고에 원문 캡처를 예약한다. 예약했으면 공용 공고 id, 아니면 null.
 * - 다시 가져오기(refresh)는 이미 찍은 캡처도 다시 찍는다(force) — 공용 공고당 1시간 3회(POSTING_CAPTURE_TARGET_LIMIT).
 * - 그 밖에는 요청한 적 없음·실패(시도 상한 전)·멈춘 작업일 때만 예약된다(requestCapture 규칙). 예외를 던지지 않는다.
 */
export async function queueCaptureForImport(importId: string, now: number = Date.now()): Promise<string | null> {
  try {
    const row = await prisma.postingImport.findUnique({ where: { id: importId }, select: { status: true, sharedPostingId: true, refresh: true } });
    if (!row || row.status !== "completed" || !row.sharedPostingId) return null;
    const sharedId = row.sharedPostingId;
    let force = row.refresh;
    if (force && !(await hitDbLimit(POSTING_CAPTURE_TARGET_LIMIT, sharedId, now)).ok) force = false;
    return (await requestCapture(sharedId, { force, now })) ? sharedId : null;
  } catch (err) {
    console.error("[queueCaptureForImport]", importId, err);
    return null;
  }
}

/** 공용 공고를 바로 담은 경우(fromShared): 캡처가 아직 없거나 실패했으면 예약한다(기존 공고의 백필). */
export async function queueCaptureForShared(sharedId: string, now: number = Date.now()): Promise<boolean> {
  try {
    return await requestCapture(sharedId, { now });
  } catch (err) {
    console.error("[queueCaptureForShared]", sharedId, err);
    return false;
  }
}

/** after()용: 가져오기를 실행하고, 끝나면 원문 캡처까지 이어서 한다(가져오기 180초 + 캡처 75초 < maxDuration 300). 던지지 않는다. */
export async function runImportThenCapture(importId: string, deps: RunImportDeps & { capture?: CaptureDeps } = {}): Promise<void> {
  try {
    await runImport(importId, deps);
  } catch (err) {
    console.error("[runImport]", importId, err);
    return;
  }
  const sharedId = await queueCaptureForImport(importId);
  if (sharedId) await runPostingCapture(sharedId, deps.capture);
}
