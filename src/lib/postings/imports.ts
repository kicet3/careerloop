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
 * - 본문 붙여넣어 가져오기(pasted): 봇 차단 등으로 링크를 읽을 수 없는 공고는 사용자가 복사한 페이지 본문으로 같은 경로를 탄다
 *   (URL은 출처 링크·중복 판별에 쓰고, 공고 찾기에 같은 링크가 있으면 그것을 담는다). 결과는 링크 공용 공고로 올리지 않고
 *   직접 입력 공고처럼 만든다(검증하지 못한 본문의 링크 선점·개인정보 공유 방지 — runImport). 본문은 저장하지 않고 실행에만 넘기므로(runImport deps.pastedText)
 *   실행이 멈춰 조회 시 다시 실행되면 링크 읽기로 돌아가 같은 차단 안내로 끝난다. 원문 캡처는 시도하지 않는다.
 * - 원문만 붙여넣기(text-only, '직접 추가'의 AI 추가): 붙여넣기에서 링크를 비우면 작업 행 url은 ''(url_key null)로 두고 링크 검사·
 *   공고 찾기 재사용·중복 판별·출처 링크 없이 같은 분석(근거 검증·구조화·하루 횟수)을 탄다. 멈춰 다시 실행되면 읽을 링크가 없어
 *   TEXT_IMPORT_INTERRUPTED_ERROR로 끝난다.
 * - 대체 경로(실행마다 각 1회, 앞 경로가 공고를 내지 못했을 때만 다음으로): 본문을 자바스크립트로 그리는 사이트는 정적 HTML에 공고가 없다.
 *   1) 정적 HTML + AI 추출. 정적 본문이 빈 껍데기(needsRendering)면 AI 없이 바로 2)로.
 *   2) 데이터 요청(requesting, request-data.ts): 정적 HTML의 스크립트에서 페이지가 상세를 불러오는 같은 출처 데이터 주소를 찾아
 *      브라우저 없이 GET으로 받고, 공고처럼 보이는 응답으로 AI 추출.
 *   3) 브라우저로 열어 읽기(rendering, render.ts): 헤드리스 브라우저로 열어 그려진 본문으로 AI 추출.
 *   근거 검증은 각 경로의 본문 기준, 출처 링크는 원래 공고 주소. AI 추출은 경로마다 최대 1회(최대 3회, 빈 껍데기면 최대 2회).
 *   정적 응답이 보안 검사(blocked)면 같은 출처라 2)는 건너뛰고 3)을 한 번 정직하게 시도한다(우회 없음 — 스텔스·검사 풀기·프록시를
 *   쓰지 않고, User-Agent도 브라우저의 실제 값('HeadlessChrome' 포함) 그대로 — honestUserAgent). 열린 화면도 보안 검사이거나 열지 못하면
 *   차단 안내(붙여넣기)로 끝낸다.
 * CareerLoop(src/server/postingImport/jobs.ts)에서 가져옴 — 원본은 프로세스 메모리 Map으로 중복 실행을 막아 여러 인스턴스·재시작에서 새었다.
 */
import { isIP } from "node:net";
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { PostingImportRow, SharedPostingRow } from "@/lib/db/types";
import {
  POSTING_BLOCKED_ERROR,
  type PostingImportJob,
  type PostingImportStatus,
} from "@/lib/domain/postings";
import type { ProviderId } from "@/lib/domain/providers";
import { hitDbLimit, POSTING_CAPTURE_TARGET_LIMIT } from "@/lib/auth/db-rate-limit";
import { createLlmClient, type LlmClient } from "@/lib/llm";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { runPostingCapture, type CaptureDeps } from "./capture";
import { PostingRenderError, RENDER_GENERIC_ERROR, renderPostingPage, type RenderPageFn } from "./render";
import { requestPostingData, type RequestDataFn } from "./request-data";
import { isRenderedChallenge, needsRendering, renderedPageText } from "./rendered-text";
import { requestCapture } from "./capture-store";
import { extractPosting, PostingExtractError } from "./extract";
import { fetchPostingPage, isPublicAddress, looksLikeChallengeText, postingBlockedError, PostingFetchError, type FetchDeps } from "./fetch";
import { safePostingAiError } from "./http";
import { pastedPageText, postingPageText } from "./page-text";
import { createPosting, DuplicatePostingError, findPostingIdByUrl, releaseMovedShared } from "./service";
import { findSharedPostingByUrlKey, refreshSharedImporterCount, saveSharedToLibrary, syncPostingFromShared, upsertSharedPosting } from "./shared";
import { isValidUrl, normalizeUrl, parsePostingUrl, PostingUrlError } from "./url";

/** 실행 1회 전체 상한(페이지 읽기 + AI 분석). */
export const IMPORT_TIME_LIMIT_MS = 180_000;
/** 이만큼 갱신이 없으면 실행이 죽은 것으로 본다(IMPORT_TIME_LIMIT_MS보다 넉넉히). */
export const IMPORT_STALE_MS = 5 * 60_000;
export const MAX_IMPORT_ATTEMPTS = 3;
/** 사용자당 동시에 진행할 수 있는 가져오기. */
export const MAX_ACTIVE_IMPORTS = 3;

const ACTIVE: PostingImportStatus[] = ["queued", "reading", "requesting", "rendering", "analyzing"];
/** 실행 중 상태(멈춤 판단 대상). */
const RUNNING: PostingImportStatus[] = ["reading", "requesting", "rendering", "analyzing"];
const STALE_ERROR = "공고 가져오기가 중간에 끊겼습니다. 다시 시도해 주세요.";
/** 붙여넣은 내용이 공고가 아니라 보안 검사 화면일 때. */
export const PASTED_CHALLENGE_ERROR =
  "붙여넣은 내용이 공고가 아니라 보안 검사 화면입니다. 브라우저에서 보안 검사를 마치고 공고 내용이 보일 때 페이지 전체를 복사해 다시 붙여넣어 주세요.";

/** 붙여넣은 내용에서 회사·모집 직무를 찾지 못했을 때(링크 안내 문구 대신). */
export const PASTED_NOT_POSTING_ERROR =
  "공고 내용을 찾지 못했습니다. 회사 이름과 모집 직무가 보이는 채용 공고 본문 전체를 복사해 다시 붙여넣어 주세요.";
/** 원문만 붙여넣은 작업이 멈춰 다시 실행될 때(본문은 저장하지 않아 다시 읽을 수 없다). */
export const TEXT_IMPORT_INTERRUPTED_ERROR = "공고 원문 분석이 중간에 끊겼습니다. 공고 원문을 다시 붙여넣어 주세요.";

export function toImportJob(row: PostingImportRow): PostingImportJob {
  return {
    id: row.id,
    url: row.url,
    status: row.status,
    error: row.error ?? null,
    errorCode: row.status === "failed" && row.error === POSTING_BLOCKED_ERROR ? "blocked" : null,
    postingId: row.postingId ?? null,
    sharedPostingId: row.sharedPostingId ?? null,
    refresh: row.refresh,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** 진행 중인데 오래 갱신되지 않은 작업(조회 시 다시 실행할 대상). */
export function isImportStale(job: Pick<PostingImportJob, "status" | "updatedAt">, now = Date.now()): boolean {
  return ACTIVE.includes(job.status) && now - job.updatedAt > IMPORT_STALE_MS;
}

export interface CreateImportOptions {
  /** '다시 가져오기': 공용 공고가 있어도 페이지를 다시 읽는다. 내 보관함에 같은 URL이 있으면 409 대신 그 공고를 새 내용으로 맞춘다. */
  refresh?: boolean;
  /**
   * 본문 붙여넣어 가져오기: 실행(runImport)에 붙여넣은 본문을 넘긴다. refresh는 쓰지 않는다. 같은 URL을 진행 중인 작업이 있으면
   * 재사용하지 않고 409(그 작업은 붙여넣은 본문을 모른다).
   */
  pasted?: boolean;
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
  const pasted = opts.pasted ?? false;
  const refresh = !pasted && (opts.refresh ?? false);
  // 원문만 붙여넣기(링크 없음): 링크 검사·공고 찾기 재사용·중복 판별을 건너뛴다.
  if (pasted && !rawUrl.trim()) return createImportRow(userId, { url: "", key: null, refresh: false, existing: null, pasted, now });
  let url: string;
  try {
    const parsed = parsePostingUrl(rawUrl);
    // 붙여넣기는 서버가 접속하지 않아 DNS 검사(fetch.ts publicTarget)를 거치지 않는다 — 출처 링크로 남길 만한 공개 주소인지
    // 형식으로 확인한다(점이 있는 호스트, IP 리터럴이면 공개 주소). 캡처 등 나중의 접속은 각자 DNS 검사를 한다.
    if (pasted && !isPublicSourceUrl(parsed)) throw new PostingUrlError("외부에 공개된 채용 공고 주소만 가져올 수 있습니다.");
    url = parsed.href;
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

  return createImportRow(userId, { url, key, refresh, existing, pasted, now });
}

/** 제한(동시 진행·하루 횟수)을 확인하고 queued 작업 행을 만든다. key null: 원문만 붙여넣기(같은 링크 작업 재사용 없음). */
async function createImportRow(
  userId: string,
  { url, key, refresh, existing, pasted, now }: { url: string; key: string | null; refresh: boolean; existing: string | null; pasted: boolean; now: number },
): Promise<CreateImportResult> {
  return prisma.$transaction(async (tx) => {
    // 같은 사용자의 가져오기 생성을 직렬화한다(READ COMMITTED에서는 개수 확인과 삽입 사이에 다른 요청이 끼어들 수 있다).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`posting-import:${userId}`}))`;
    const active = (await tx.postingImport.findMany({ where: { userId, status: { in: ACTIVE } } })) as PostingImportRow[];
    // 같은 공고(www·추적 파라미터·끝 슬래시만 다른 링크 포함)를 진행 중이면 그 작업을 재사용한다.
    const same = key ? active.find((r) => (r.urlKey ?? normalizeUrl(r.url)) === key && !isImportStale(toImportJob(r), now)) : undefined;
    if (same && pasted) throw new FeatureError("같은 공고를 가져오는 중입니다. 끝난 뒤 다시 시도하세요.", 409);
    if (same) return { job: toImportJob(same), reused: true, fromShared: false };
    if (active.filter((r) => !isImportStale(toImportJob(r), now)).length >= MAX_ACTIVE_IMPORTS) {
      throw new FeatureError("진행 중인 공고 가져오기가 많습니다. 끝난 뒤 다시 시도하세요.", 409);
    }
    // 하루 횟수 제한은 두지 않는다(동시 진행 수와 분당 연속 요청 제한만 남긴다).
    const at = new Date(now);
    const row = await tx.postingImport.create({
      data: {
        id: nanoid(),
        userId,
        url: stripNul(url),
        urlKey: key ? stripNul(key) : null,
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

/** 출처 링크로 둘 공개 주소 형식인지(접속하지 않는다): 호스트에 점이 있고, IP 리터럴이면 공개 주소. */
function isPublicSourceUrl(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host);
  return isValidUrl(url.href) && !/\.(?:local|localhost|internal|lan|home\.arpa)$/i.test(host);
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
  const before = await prisma.jobPosting.findFirst({ select: { sharedPostingId: true }, where: { id: postingId, userId } });
  const { count } = await prisma.jobPosting.updateMany({ where: { id: postingId, userId }, data: { sharedPostingId: sharedId } });
  if (count === 0) return null;
  // 다른 공용 공고(직접 입력으로 만든 것 등)에서 옮겨 왔으면 그 공용 공고는 지우지 않고 정리한다(담은 수를 다시 세고,
  // 내가 직접 입력으로 만들어 남은 사람이 없으면 숨긴다 — 더는 고칠 수 없는 사본이 공고 찾기에 남지 않게).
  if (before?.sharedPostingId && before.sharedPostingId !== sharedId) await releaseMovedShared(userId, before.sharedPostingId);
  const synced = await syncPostingFromShared(userId, postingId);
  return synced?.id ?? null;
}

class ImportTimeoutError extends Error {
  constructor() {
    super("import timeout");
    this.name = "ImportTimeoutError";
  }
}

/** 다른 실행이 작업을 가져갔다(이후 쓰기를 하지 않고 끝낸다). */
class ImportSupersededError extends Error {
  constructor() {
    super("import superseded");
    this.name = "ImportSupersededError";
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
  /**
   * 브라우저로 열어 읽기(render.ts). 없으면 기본(헤드리스 Chromium), null이면 열어 읽지 않는다.
   * fetchPage나 fetchDeps.connect를 바꾼 경우(테스트)는 기본 브라우저를 쓰지 않는다(실제 인터넷에 접속하지 않게) — 필요하면 함께 넣는다.
   */
  renderPage?: RenderPageFn | null;
  /**
   * 데이터 요청(request-data.ts). 없으면 기본(정적 HTML의 스크립트로 찾은 같은 출처 데이터 주소를 GET), null이면 하지 않는다.
   * fetchPage나 fetchDeps.connect를 바꾼 경우(테스트)는 기본을 쓰지 않는다 — 필요하면 함께 넣는다.
   */
  requestData?: RequestDataFn | null;
  /** 본문 붙여넣어 가져오기: 페이지를 읽지 않고 이 본문(사용자가 복사한 페이지 텍스트)으로 분석한다. */
  pastedText?: string;
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
      OR: [{ status: "queued" }, { status: { in: RUNNING }, updatedAt: { lt: staleBefore } }],
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
    const pasted = deps.pastedText !== undefined;
    let page: { url: string; pageText: string };
    let staticHtml = "";
    let staticBlocked = false;
    if (pasted) {
      page = { url: claimed.url, pageText: pastedPageText(deps.pastedText!) };
    } else {
      // 원문만 붙여넣은 작업이 멈춰 다시 실행됐다 — 읽을 링크가 없다.
      if (!claimed.url) throw new PostingExtractError(TEXT_IMPORT_INTERRUPTED_ERROR);
      try {
        const fetched = deps.fetchPage
          ? await deps.fetchPage(claimed.url, { signal })
          : await fetchPostingPage(claimed.url, { ...deps.fetchDeps, signal });
        page = { url: fetched.url, pageText: postingPageText(fetched.html) };
        staticHtml = fetched.html;
      } catch (err) {
        // 보안 검사(차단) 응답: 브라우저로 한 번 열어 본다(아래). 브라우저를 쓸 수 없으면 그대로 차단 안내.
        if (!(err instanceof PostingFetchError && err.code === "blocked") || !defaultRenderer(deps)) throw err;
        console.warn("[runImport] static fetch blocked — trying browser once");
        staticBlocked = true;
        page = { url: claimed.url, pageText: "" };
      }
    }
    signal.throwIfAborted();

    // 데이터 요청은 실행마다 한 번(정적 응답이 차단이면 하지 않는다 — 같은 출처라 다시 막힌다). 찾지 못하면 null.
    const requester = pasted ? null : defaultRequester(deps);
    let requested = false;
    const tryRequest = async (): Promise<{ url: string; pageText: string } | null> => {
      if (!requester || requested || staticBlocked || !staticHtml) return null;
      requested = true;
      if (!(await write({ status: "requesting" }))) throw new ImportSupersededError();
      try {
        const r = await requester({ url: page.url, html: staticHtml }, { signal });
        signal.throwIfAborted();
        console.info("[runImport] request tier", r.kind, `requests=${r.requests}`, r.kind === "found" ? r.dataUrl : "");
        // 공고 주소는 정적으로 읽은 최종 주소를 그대로 쓴다(데이터 주소는 출처 링크로 쓰지 않는다).
        return r.kind === "found" ? { url: page.url, pageText: r.pageText } : null;
      } catch (err) {
        if (signal.aborted) throw err;
        console.error("[runImport] request tier", err);
        return null;
      }
    };

    // 브라우저로 열어 읽기는 실행마다 한 번. 실패하면 그 문구를 남겨 두고(정적 본문으로 분석이 끝나면 쓰지 않는다) null.
    const render = pasted ? null : defaultRenderer(deps);
    let rendered = false;
    let renderFailure: string | null = null;
    const tryRender = async (): Promise<{ url: string; pageText: string } | null> => {
      if (!render || rendered) return null;
      rendered = true;
      if (!(await write({ status: "rendering" }))) throw new ImportSupersededError();
      try {
        // 막힌 걸 알고 다시 여는 경우는 User-Agent를 바꾸지 않는다(헤드리스 표시를 지우지 않는다).
        const r = await render(page.url, staticBlocked ? { signal, honestUserAgent: true } : { signal });
        signal.throwIfAborted();
        if (isRenderedChallenge(r)) throw postingBlockedError();
        if (r.status >= 400) throw new PostingRenderError(`공고 페이지가 오류를 돌려줬습니다(HTTP ${r.status}).`);
        // 공고 주소는 정적으로 읽은 최종 주소를 그대로 쓴다(브라우저 안의 이동·해시 변경으로 공용 공고 키가 바뀌지 않게).
        return { url: page.url, pageText: renderedPageText(r) };
      } catch (err) {
        if (signal.aborted || (err instanceof PostingFetchError && err.code === "blocked")) throw err;
        renderFailure = err instanceof PostingRenderError ? err.message : RENDER_GENERIC_ERROR;
        if (!(err instanceof PostingRenderError)) console.error("[runImport] render", err);
        else console.warn("[runImport] render", err.message);
        return null;
      }
    };

    // 리다이렉트 뒤 최종 주소로 다시 확인한다(입력 주소로는 못 찾은 경우) — AI 분석 전에 끝내 비용을 쓰지 않는다.
    if (!claimed.refresh && page.url) {
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

    if (staticBlocked) {
      // 정적 응답이 보안 검사였다 — 브라우저로 한 번 열어 본다. 열지 못하거나(브라우저 없음·시간 초과) 열린 화면도 검사면 차단 안내.
      const opened = await tryRender();
      if (!opened) throw postingBlockedError();
      page = opened;
    } else if (!pasted && (requester || render) && needsRendering(staticHtml, page.pageText)) {
      // 정적 본문이 자바스크립트로 그려지는 빈 껍데기면 AI 분석 전에 데이터 요청 → 브라우저 순으로 본문을 얻는다(헛된 분석 1회를 아낀다).
      page = (await tryRequest()) ?? (await tryRender()) ?? page;
    }

    if (!(await write({ status: "analyzing" }))) return;

    const provider = deps.llm ? null : (deps.provider ?? (await resolveRequestedProvider(null)));
    const llm = deps.llm ?? createLlmClient(provider!, { userId: claimed.userId, referenceId: claimed.id });
    const extract = async (target: { url: string; pageText: string }) => {
      try {
        return await extractPosting(target, llm, { signal });
      } catch (err) {
        // 200으로 온 보안 검사 페이지(표식 없이 문구만 남은 경우)는 '공고 아님'으로 끝난다 — 차단 안내로 바꾼다.
        if (err instanceof PostingExtractError && looksLikeChallengeText(target.pageText)) {
          if (pasted) throw new PostingExtractError(PASTED_CHALLENGE_ERROR);
          throw postingBlockedError();
        }
        if (err instanceof PostingExtractError && pasted) throw new PostingExtractError(PASTED_NOT_POSTING_ERROR);
        throw err;
      }
    };
    let extracted: Awaited<ReturnType<typeof extractPosting>> | null = null;
    try {
      extracted = await extract(page);
    } catch (err) {
      if (!(err instanceof PostingExtractError) || pasted) throw err;
      // 이 본문으로는 회사·직무를 찾지 못했다 — 아직 쓰지 않은 다음 경로(데이터 요청 → 브라우저)의 본문으로 한 번씩 더 분석한다.
      let last: PostingExtractError = err;
      for (const next of [tryRequest, tryRender]) {
        const again = await next();
        if (!again) continue;
        page = again;
        if (!(await write({ status: "analyzing" }))) return;
        try {
          extracted = await extract(page);
          break;
        } catch (e) {
          if (!(e instanceof PostingExtractError)) throw e;
          last = e;
        }
      }
      if (!extracted) throw renderFailure ? new PostingExtractError(renderFailure) : last;
    }
    const { posting, structure, sourceText } = extracted;
    signal.throwIfAborted();
    const extractedBy = provider ?? llm.name;
    if (pasted) {
      // 붙여넣은 본문은 공고 찾기의 링크 공고(url_key)로 올리지 않는다: 서버가 페이지를 확인하지 못했으므로 아무 링크에나 지어낸
      // 본문을 붙여 공용 공고를 선점할 수 있고, 전체 복사에 섞인 개인정보(머리글의 이름·이메일 등)가 원문으로 공유될 수 있다.
      // 직접 입력 공고와 같이 만든다(createPosting이 url 없는 공용 공고를 공개 필드만으로 만든다 — 붙여넣은 원문은 내 공고에만).
      // 작업 행의 sharedPostingId도 비워 둔다(같은 입력 주소의 별칭 재사용 findSharedPostingByAlias에 걸리지 않게).
      const own = await createPosting(claimed.userId, posting, { extractedBy, structure, sourceText });
      await write({ status: "completed", postingId: own.id, sharedPostingId: null, error: null });
      return;
    }
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
    if (err instanceof ImportSupersededError) return;
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

/** 기본 데이터 요청 함수. 페이지 가져오기를 바꾼 경우(테스트)는 쓰지 않는다 — RunImportDeps.requestData 참고. */
function defaultRequester(deps: RunImportDeps): RequestDataFn | null {
  if (deps.requestData !== undefined) return deps.requestData;
  if (deps.fetchPage || deps.fetchDeps?.connect) return null;
  const lookup = deps.fetchDeps?.lookup;
  return (page, { signal }) => requestPostingData(page, { lookup, signal });
}

/** 기본 열어 읽기 함수. 페이지 가져오기를 바꾼 경우(테스트)는 쓰지 않는다 — RunImportDeps.renderPage 참고. */
function defaultRenderer(deps: RunImportDeps): RenderPageFn | null {
  if (deps.renderPage !== undefined) return deps.renderPage;
  if (deps.fetchPage || deps.fetchDeps?.connect) return null;
  const lookup = deps.fetchDeps?.lookup;
  return (url, { signal, honestUserAgent }) => renderPostingPage(url, { lookup, signal, honestUserAgent });
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

/**
 * after()용: 가져오기를 실행하고, 끝나면 원문 캡처까지 이어서 한다(가져오기 180초 — 브라우저로 열어 읽기 40초 포함 — + 캡처 75초
 * < maxDuration 300). 던지지 않는다.
 */
export async function runImportThenCapture(importId: string, deps: RunImportDeps & { capture?: CaptureDeps } = {}): Promise<void> {
  try {
    await runImport(importId, deps);
  } catch (err) {
    console.error("[runImport]", importId, err);
    return;
  }
  // 본문 붙여넣어 가져오기: 서버가 페이지를 열 수 없는(봇 차단) 공고라 캡처해도 보안 검사 화면만 찍힌다 — 시도하지 않는다.
  if (deps.pastedText !== undefined) return;
  const sharedId = await queueCaptureForImport(importId);
  if (sharedId) await runPostingCapture(sharedId, deps.capture);
}
