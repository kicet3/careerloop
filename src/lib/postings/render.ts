import "server-only";
/**
 * 공고 페이지를 헤드리스 Chromium으로 열어 읽기(가져오기의 대체 경로). 본문을 자바스크립트로 그리는 채용 사이트
 * (예: Knockout으로 상세 API를 불러 그리는 careers.smilegate.com)는 정적 HTML에 공고가 없다 — 브라우저로 열어
 * 그려진 본문(innerText)과 로드 중 받은 같은 사이트 JSON 응답을 모은다. 분석은 기존 AI 추출(extract.ts)이 그대로 한다.
 *
 * - 브라우저·SSRF 방어·동시 실행 상한은 browser.ts(원문 캡처와 공용). 이미지·글꼴·동영상은 받지 않는다(읽기만 한다).
 * - 우회하지 않는다: 스텔스·지문 위장·검사 풀기를 쓰지 않는다. 열린 화면이 보안 검사면 차단 안내(붙여넣기)로 끝난다(imports.ts).
 * - POSTING_RENDER: 탐색 15초, 탐색 뒤 조용해질 때까지 최대 10초(네트워크 유휴·본문 길이 안정), 전체 40초, 전송량 15MB,
 *   JSON 응답은 같은 사이트·응답당 512KB·합계 2MB·20개까지.
 * - 페이지 안의 버튼을 누르지 않는다('더보기' 등 — 이동·제출 위험). 접힌 내용은 JSON 응답으로 보완한다.
 */
import type { HTTPResponse, ResourceType } from "puppeteer-core";
import { MAX_PAGE_BYTES, type LookupFn } from "./fetch";
import { withGuardedPage } from "./browser";
import type { RenderedPageContent } from "./rendered-text";

export const POSTING_RENDER = {
  navigationTimeoutMs: 15_000,
  /** 탐색 뒤 네트워크 유휴·본문 안정을 기다리는 상한. */
  settleMs: 10_000,
  /** 브라우저 실행부터 끝까지(서버리스 첫 실행의 Chromium 압축 풀기 포함). */
  totalTimeoutMs: 40_000,
  maxTransferBytes: 15 * 1024 * 1024,
  maxTextChars: 200_000,
  maxDataResponses: 20,
  maxDataResponseBytes: 512 * 1024,
  maxDataBytes: 2 * 1024 * 1024,
} as const;

/** 사용자에게 보여도 되는 열어 읽기 실패. */
export class PostingRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingRenderError";
  }
}

export const RENDER_GENERIC_ERROR = "공고 페이지를 브라우저로 열어 읽지 못했습니다. 잠시 후 다시 시도하거나 '본문 붙여넣기'로 가져오세요.";
export const RENDER_TIMEOUT_ERROR = "공고 페이지를 브라우저로 여는 데 시간이 너무 걸렸습니다. 잠시 후 다시 시도하거나 '본문 붙여넣기'로 가져오세요.";
export const RENDER_NO_BROWSER_ERROR = "이 공고는 페이지를 브라우저로 열어야 내용이 보이는데, 지금은 브라우저를 쓸 수 없습니다. '본문 붙여넣기'로 가져오세요.";

export interface RenderDeps {
  lookup?: LookupFn;
  executablePath?: string;
  signal?: AbortSignal;
}

export interface RenderedPage extends RenderedPageContent {
  /** 브라우저가 마지막으로 머문 주소. */
  url: string;
}

/** 페이지를 열어 읽는 함수(가져오기 작업에 주입 — 테스트는 가짜). */
export type RenderPageFn = (url: string, opts: { signal: AbortSignal }) => Promise<RenderedPage>;

const READ_ONLY_BLOCK: ReadonlySet<ResourceType> = new Set(["image", "media", "font"]);

/** 등록 도메인 근사(마지막 두 마디, co.kr 같은 2단계 국가 도메인이면 세 마디). */
export function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  const n = /^(?:co|or|ne|go|ac|re|pe|com|net|org|gov|edu)$/.test(labels.at(-2) ?? "") && (labels.at(-1)?.length ?? 0) === 2 ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** 보이는 본문 길이가 멈출 때까지(또는 상한까지) 기다린다 — 문자열로 넘겨 번들러 변환을 피한다. */
const WAIT_TEXT_STABLE = (maxMs: number) => `(async () => {
  const started = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - started < ${maxMs}) {
    const len = document.body ? document.body.innerText.length : 0;
    if (len === last && len > 0) { if (++stable >= 3) break; } else { stable = 0; last = len; }
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
})()`;

const READ_HTML = `(() => document.documentElement ? document.documentElement.outerHTML.slice(0, ${MAX_PAGE_BYTES}) : "")()`;

const READ_TEXT = `(() => (document.body ? document.body.innerText : "").slice(0, ${POSTING_RENDER.maxTextChars}))()`;

export interface DataResponseMeta {
  requestId: string;
  /** CDP Network.ResourceType("XHR", "Fetch", "Document" …). */
  type: string;
  status: number;
  url: string;
  mimeType?: string;
  headers?: Record<string, unknown>;
}

export interface DataLimits {
  maxDataResponses: number;
  maxDataResponseBytes: number;
  maxDataBytes: number;
}

/** 모을 만한 응답인가: 페이지가 부른 XHR/fetch, 2xx, 같은 사이트, JSON, 선언 크기(있으면)가 상한 안. */
export function isCollectableDataResponse(meta: DataResponseMeta, site: string, limits: DataLimits = POSTING_RENDER): boolean {
  if (meta.type !== "XHR" && meta.type !== "Fetch") return false;
  if (meta.status < 200 || meta.status >= 300) return false;
  let host: string;
  try {
    host = new URL(meta.url).hostname;
  } catch {
    return false;
  }
  if (siteOf(host) !== site) return false;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (!/json/i.test(meta.mimeType ?? "") && !/json/i.test(headers["content-type"] ?? "")) return false;
  const declared = Number(headers["content-length"] ?? "0");
  return !(declared > limits.maxDataResponseBytes);
}

/**
 * 같은 사이트 JSON 응답 모으기. 본문은 응답이 다 받아진 뒤(loadingFinished)에만, 그동안 센 실제 크기(압축 푼 바이트)가
 * 응답당 상한 안이고 개수·합계가 남았을 때만 가져온다 — chunked·gzip처럼 content-length가 없거나 믿을 수 없어도 Node로는
 * 상한 넘는 본문이 들어오지 않는다.
 */
export function createDataCollector(site: string, limits: DataLimits = POSTING_RENDER) {
  const received = new Map<string, number>();
  const pending: Promise<void>[] = [];
  const data: unknown[] = [];
  let bytes = 0;
  return {
    onResponse(meta: DataResponseMeta) {
      if (isCollectableDataResponse(meta, site, limits)) received.set(meta.requestId, 0);
    },
    onData(requestId: string, length: number) {
      const n = received.get(requestId);
      if (n === undefined) return;
      if (n + length > limits.maxDataResponseBytes) received.delete(requestId);
      else received.set(requestId, n + length);
    },
    onFailed(requestId: string) {
      received.delete(requestId);
    },
    onFinished(requestId: string, getBody: () => Promise<{ body: string; base64Encoded: boolean }>) {
      const size = received.get(requestId);
      received.delete(requestId);
      if (size === undefined || pending.length >= limits.maxDataResponses || bytes + size > limits.maxDataBytes) return;
      bytes += size; // 가져오기 전에 예약 — 동시에 끝난 응답들이 합계를 넘지 않게.
      pending.push(
        getBody()
          .then(({ body, base64Encoded }) => {
            const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
            if (text.length > limits.maxDataResponseBytes) return;
            data.push(JSON.parse(text));
          })
          .catch(() => {}),
      );
    },
    /** 가져오는 중인 본문을 최대 ms만 기다린다. */
    settled(ms: number): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([Promise.allSettled(pending), new Promise<void>((r) => (timer = setTimeout(r, ms)))]).then(() => clearTimeout(timer));
    },
    data: () => [...data],
  };
}

/** URL 한 개를 브라우저로 열어 그려진 본문을 읽는다. 실패는 PostingRenderError(사용자용 문구) 또는 호출자 취소의 reason. */
export async function renderPostingPage(url: string, deps: RenderDeps = {}): Promise<RenderedPage> {
  return withGuardedPage(
    url,
    {
      lookup: deps.lookup,
      executablePath: deps.executablePath,
      signal: deps.signal,
      totalTimeoutMs: POSTING_RENDER.totalTimeoutMs,
      maxTransferBytes: POSTING_RENDER.maxTransferBytes,
      blockedResourceTypes: READ_ONLY_BLOCK,
      error: (message) => new PostingRenderError(message),
      isOwnError: (err): err is PostingRenderError => err instanceof PostingRenderError,
      messages: { noBrowser: RENDER_NO_BROWSER_ERROR, timeout: RENDER_TIMEOUT_ERROR, generic: RENDER_GENERIC_ERROR },
      logTag: "render",
    },
    async ({ page, target, signal, race }) => {
      const collector = createDataCollector(siteOf(target.hostname));
      // JSON 응답은 따로 연 CDP 세션에서 받는다: 이 세션의 버퍼 상한(응답당·합계) 때문에 큰 본문은 Chromium 안에서 버려지고,
      // 받은 크기(dataReceived — 압축 푼 크기)도 직접 세므로 chunked·gzip 응답도 본문을 Node로 가져오기 전에 거른다.
      const net = await page.createCDPSession();
      net.on("Network.responseReceived", (e) =>
        collector.onResponse({ requestId: e.requestId, type: e.type, status: e.response.status, url: e.response.url, mimeType: e.response.mimeType, headers: e.response.headers }),
      );
      net.on("Network.dataReceived", (e) => collector.onData(e.requestId, e.dataLength));
      net.on("Network.loadingFailed", (e) => collector.onFailed(e.requestId));
      net.on("Network.loadingFinished", (e) =>
        collector.onFinished(e.requestId, () => net.send("Network.getResponseBody", { requestId: e.requestId })),
      );
      await net.send("Network.enable", {
        maxResourceBufferSize: POSTING_RENDER.maxDataResponseBytes,
        maxTotalBufferSize: POSTING_RENDER.maxDataBytes,
      });

      let response: HTTPResponse | null;
      try {
        response = await race(page.goto(target.href, { waitUntil: "domcontentloaded", timeout: POSTING_RENDER.navigationTimeoutMs }));
      } catch (err) {
        if (signal.aborted) throw err;
        console.warn("[render] goto", (err as Error)?.message);
        throw new PostingRenderError("공고 페이지를 브라우저로 열지 못했습니다. 페이지가 응답하지 않거나 접속을 막았습니다.");
      }
      if (!response) throw new PostingRenderError(RENDER_GENERIC_ERROR);

      // 자바스크립트가 상세 데이터를 불러와 그릴 때까지(상한 안에서) 기다린다.
      const settleStarted = Date.now();
      await race(page.waitForNetworkIdle({ idleTime: 500, timeout: Math.round(POSTING_RENDER.settleMs * 0.7) }).catch(() => {}));
      const left = Math.max(1_000, POSTING_RENDER.settleMs - (Date.now() - settleStarted));
      await race(page.evaluate(WAIT_TEXT_STABLE(left)).catch(() => null));

      const text = String((await race(page.evaluate(READ_TEXT).catch(() => ""))) ?? "");
      // DOM 전체(page.content())를 Node로 옮기지 않고 페이지 안에서 잘라 받는다 — 스크립트가 만든 거대한 DOM 방어.
      const html = String((await race(page.evaluate(READ_HTML).catch(() => ""))) ?? "");
      // 받던 JSON 본문은 짧게만 더 기다린다.
      await race(collector.settled(1_500));
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(response.headers())) headers[k.toLowerCase()] = v;
      return { url: page.url() || target.href, status: response.status(), headers, html, text, data: collector.data() };
    },
  );
}
