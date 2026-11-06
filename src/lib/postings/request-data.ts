import "server-only";
/**
 * 데이터 요청(가져오기의 두 번째 경로, 상태 'requesting'): 본문을 자바스크립트로 그리는 공고 페이지는 상세 내용을 같은 사이트의
 * 공개 데이터 주소(예: careers.smilegate.com의 /api/apply/announce/guest/{seq})에서 불러온다. 브라우저를 띄우지 않고 정적 HTML의
 * 스크립트에서 그 주소를 찾아(data-endpoints.ts — 결정적, AI 없음) 평범한 GET 요청으로 받아 본다.
 *
 * - 접속은 fetch.ts fetchPublicResource(공개 주소만·DNS 고정·포트 80/443·리다이렉트 3회 재검사, 같은 출처 안에서만)로만 한다.
 *   GET만, 쿠키·세션 없음, User-Agent는 정직하게, Referer는 공고 페이지 주소.
 * - 예산(POSTING_REQUEST): 요청 8회(스크립트 파일 포함), 경로 전체 10초, 요청당 5초, 데이터 응답 1MB·스크립트 512KB.
 * - 첫 번째로 이 공고의 상세인 응답에서 멈춘다: 공고 한 건의 레코드(목록 아님)이고, 값에 페이지 식별자나 페이지 제목이 있고,
 *   내용이 공고처럼 보여야 한다(data-endpoints.ts requestedPageText·requestedHtmlText). 응답이 보안 검사면 'blocked'(다음 경로 — 브라우저 — 로 넘긴다).
 * - 우회하지 않는다: 로그인이 필요한 주소(401/403)는 그냥 다음 후보로 넘어가고, 차단을 풀려고 하지 않는다.
 */
import { fetchPublicResource, PostingFetchError, type FetchDeps } from "./fetch";
import { appScriptUrls, discoverDataEndpoints, pageScripts, parseDataBody, requestedHtmlText, requestedPageText } from "./data-endpoints";
import { postingPageText } from "./page-text";

export const POSTING_REQUEST = {
  maxRequests: 8,
  totalTimeoutMs: 10_000,
  requestTimeoutMs: 5_000,
  maxDataBytes: 1024 * 1024,
  maxScriptBytes: 512 * 1024,
} as const;

export type RequestDataResult =
  | { kind: "found"; dataUrl: string; pageText: string; requests: number }
  | { kind: "none"; requests: number; candidates: number }
  | { kind: "blocked"; requests: number };

/** 데이터 요청 함수(가져오기 작업에 주입 — 테스트는 가짜). page는 정적으로 읽은 최종 주소와 HTML. */
export type RequestDataFn = (page: { url: string; html: string }, opts: { signal: AbortSignal }) => Promise<RequestDataResult>;

export interface RequestDataDeps extends Omit<FetchDeps, "signal" | "timeoutMs"> {
  signal: AbortSignal;
  /** 테스트용 예산 덮어쓰기. */
  limits?: Partial<Record<keyof typeof POSTING_REQUEST, number>>;
}

const DATA_ACCEPT = "application/json, text/plain;q=0.9, */*;q=0.1";
const SCRIPT_ACCEPT = "application/javascript, text/javascript, */*;q=0.1";

/** 정적 HTML의 스크립트로 데이터 주소를 찾아 차례로 받아 본다. 호출자 취소는 그 reason으로 던지고, 그 밖의 실패는 'none'. */
export async function requestPostingData(page: { url: string; html: string }, deps: RequestDataDeps): Promise<RequestDataResult> {
  const limits = { ...POSTING_REQUEST, ...deps.limits };
  const pageUrl = new URL(page.url);
  const budget = AbortSignal.timeout(limits.totalTimeoutMs);
  const signal = AbortSignal.any([deps.signal, budget]);
  const started = Date.now();
  let requests = 0;

  /** 요청 1회(예산 안에서). 예산이 끝났으면 null, 보안 검사면 'blocked'. */
  const get = async (url: string, accept: string, maxBytes: number) => {
    const left = limits.totalTimeoutMs - (Date.now() - started);
    if (requests >= limits.maxRequests || left <= 0 || signal.aborted) return null;
    requests++;
    try {
      return await fetchPublicResource(url, {
        lookup: deps.lookup,
        connect: deps.connect,
        signal,
        timeoutMs: Math.min(limits.requestTimeoutMs, left),
        accept,
        referer: pageUrl.href,
        maxBytes,
      });
    } catch (err) {
      if (deps.signal.aborted) throw deps.signal.reason ?? err;
      if (err instanceof PostingFetchError && err.code === "blocked") return "blocked" as const;
      if (!(err instanceof PostingFetchError) && !budget.aborted) console.warn("[request-data] get", (err as Error)?.message);
      return undefined;
    }
  };

  const { inline, sources } = pageScripts(page.html);
  let candidates = discoverDataEndpoints(pageUrl, inline);
  // 인라인 스크립트에서 못 찾으면 같은 출처 앱 스크립트 파일(라이브러리 제외, 최대 3개)도 읽어 본다.
  if (!candidates.length) {
    const scripts = [...inline];
    for (const src of appScriptUrls(sources, pageUrl)) {
      const res = await get(src, SCRIPT_ACCEPT, limits.maxScriptBytes);
      if (res === null) break;
      if (res === "blocked") return { kind: "blocked", requests };
      if (res && /javascript|ecmascript|text\/plain/i.test(res.contentType) && res.text) scripts.push(res.text);
    }
    candidates = discoverDataEndpoints(pageUrl, scripts);
  }

  for (const candidate of candidates) {
    const res = await get(candidate, DATA_ACCEPT, limits.maxDataBytes);
    if (res === null) break;
    if (res === "blocked") return { kind: "blocked", requests };
    if (!res || !res.text) continue;
    const data = parseDataBody(res.text, res.contentType);
    let pageText: string | null = null;
    if (data !== null) pageText = requestedPageText(page.html, data, pageUrl);
    // 상세 조각을 HTML로 주는 사이트: 이 공고를 가리키는 조각만 쓴다(사이트 껍데기·오류 페이지는 버린다).
    else if (/text\/html/i.test(res.contentType)) pageText = requestedHtmlText(page.html, res.text, pageUrl, postingPageText);
    if (pageText) return { kind: "found", dataUrl: res.url, pageText, requests };
  }
  return { kind: "none", requests, candidates: candidates.length };
}
