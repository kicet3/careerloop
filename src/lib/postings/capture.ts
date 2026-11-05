import "server-only";
/**
 * 공고 원문 전체 페이지 캡처. 헤드리스 Chromium으로 공고 페이지를 열어 한 장의 WebP(높이가 WebP 한계를 넘으면 JPEG)로 찍는다.
 *
 * - 브라우저: Vercel·Lambda(process.env.VERCEL / AWS_LAMBDA_FUNCTION_NAME)는 @sparticuz/chromium + puppeteer-core,
 *   그 밖에는 CHROME_PATH, darwin이면 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome". 없으면 PostingCaptureError.
 * - SSRF(fetch.ts와 같은 규칙): 첫 주소는 publicTarget으로 확인한다. 브라우저의 모든 네트워크(하위 리소스·리다이렉트·웹소켓·
 *   서비스 워커 포함)는 capture-egress.ts의 프록시만 지나며, 프록시가 호스트를 다시 확인하고 검사한 IP로만 연결한다(DNS 고정).
 *   요청 가로채기(setRequestInterception)는 그 앞의 1차 거름망 — 허용하지 않는 스킴·호스트·포트는 abort한다.
 * - POSTING_CAPTURE: 폭 1280, 높이 상한 20000px, 품질 70, 탐색 25초·전체 75초, 전송량 25MB, 이미지 8MB.
 * - 쿠키·앱 설치 배너는 흔한 '동의'·'닫기' 버튼을 눌러 보고, 화면을 크게 덮는 고정 요소는 숨긴다(실패해도 계속).
 * - runPostingCapture: claimCapture → capturePostingPage → putObject(postingCaptureKey) → recordCaptureSuccess / recordCaptureFailure.
 *   실패 문구는 사용자에게 보여도 되는 한국어만 저장한다(내부 주소·스택은 로그에만).
 */
import { existsSync } from "node:fs";
import type { Browser, HTTPRequest, LaunchOptions } from "puppeteer-core";
import { POSTING_CAPTURE, type PostingCaptureMime } from "@/lib/domain/posting-capture";
import { deleteObject, putObject } from "@/lib/storage";
import { createHostGuard, isAllowedBrowserUrl, startEgressProxy, type HostGuard } from "./capture-egress";
import { claimCapture, postingCaptureKey, recordCaptureFailure, recordCaptureSuccess } from "./capture-store";
import { PostingFetchError, publicTarget, type LookupFn } from "./fetch";
import { PostingUrlError } from "./url";

export class PostingCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingCaptureError";
  }
}

export interface CaptureDeps {
  lookup?: LookupFn;
  /** 브라우저 실행 파일 경로(테스트·로컬). */
  executablePath?: string;
  signal?: AbortSignal;
  now?: () => number;
  /** 테스트용: 실제 브라우저 대신 이 함수로 찍는다(runPostingCapture). */
  capture?: (url: string, deps: CaptureDeps) => Promise<CapturedImage>;
}

export interface CapturedImage {
  body: Buffer;
  mime: PostingCaptureMime;
  width: number;
  height: number;
  /** 높이 상한에서 잘렸는지. */
  clipped: boolean;
}

/** WebP 한 변의 최대 픽셀(포맷 한계). 넘으면 JPEG(65535)로 찍는다. */
export const WEBP_MAX_DIMENSION = 16_383;

export const CAPTURE_GENERIC_ERROR = "원문 페이지를 캡처하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const NO_BROWSER = "캡처 브라우저가 없습니다.";

export const MAC_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** 찍을 높이·형식(순수). 문서 높이를 상한으로 자르고, WebP 한계를 넘으면 JPEG. */
export function planCapture(documentHeight: number): { height: number; mime: PostingCaptureMime; clipped: boolean } {
  const h = Math.max(1, Math.ceil(Number.isFinite(documentHeight) ? documentHeight : POSTING_CAPTURE.viewportHeight));
  const height = Math.min(h, POSTING_CAPTURE.maxHeight);
  return { height, mime: height > WEBP_MAX_DIMENSION ? "image/jpeg" : "image/webp", clipped: h > POSTING_CAPTURE.maxHeight };
}

/** 서버리스(Vercel·Lambda)에서 도는가 — @sparticuz/chromium을 쓴다. */
function isServerless(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);
}

/** 로컬 브라우저 경로(순수, 테스트용 인자). CHROME_PATH → darwin 기본 Chrome → null. */
export function localChromePath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, exists = existsSync): string | null {
  const fromEnv = env.CHROME_PATH?.trim();
  if (fromEnv) return exists(fromEnv) ? fromEnv : null;
  if (platform === "darwin" && exists(MAC_CHROME_PATH)) return MAC_CHROME_PATH;
  return null;
}

/** 쿠키·SSRF 관련 Chromium 플래그. 프록시 밖으로 나가는 경로(QUIC·WebRTC UDP·DNS 미리 읽기)를 닫는다. */
export function hardenedArgs(proxyUrl: string): string[] {
  return [
    `--proxy-server=${proxyUrl}`,
    // 기본값은 localhost·127.0.0.1을 프록시 없이 직접 연다 — 이를 끄고 루프백도 프록시(거절)로 보낸다.
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--dns-prefetch-disable",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-features=DnsOverHttps,AsyncDns,MediaRouter,OptimizationHints,Translate",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    "--hide-scrollbars",
    "--lang=ko-KR",
  ];
}

async function launchBrowser(proxyUrl: string, deps: CaptureDeps): Promise<Browser> {
  const { default: puppeteer } = await import("puppeteer-core");
  const base: LaunchOptions = {
    pipe: true,
    defaultViewport: { width: POSTING_CAPTURE.viewportWidth, height: POSTING_CAPTURE.viewportHeight, deviceScaleFactor: 1 },
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    protocolTimeout: POSTING_CAPTURE.totalTimeoutMs,
    timeout: 30_000,
  };
  if (deps.executablePath) {
    return puppeteer.launch({ ...base, executablePath: deps.executablePath, headless: true, args: hardenedArgs(proxyUrl) });
  }
  if (isServerless()) {
    const { default: chromium } = await import("@sparticuz/chromium");
    chromium.setGraphicsMode = false;
    return puppeteer.launch({
      ...base,
      executablePath: await chromium.executablePath(),
      headless: "shell",
      args: [...(await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" })), ...hardenedArgs(proxyUrl)],
    });
  }
  const local = localChromePath();
  if (!local) throw new PostingCaptureError(NO_BROWSER);
  return puppeteer.launch({ ...base, executablePath: local, headless: true, args: hardenedArgs(proxyUrl) });
}

/** 페이지 안에서 실행: 쿠키·앱 배너 닫기(버튼 클릭 → 덮는 고정 요소 숨김). 문자열로 넘겨 번들러 변환을 피한다. */
const DISMISS_BANNERS = `(() => {
  const words = /^(모두 허용|모두 동의|전체 동의|동의|동의함|동의하고 계속|수락|확인|허용|닫기|오늘 하루 보지 않기|다시 보지 않기|괜찮아요|웹으로 볼게요|모바일 웹으로 보기|accept all|accept|agree|i agree|allow all|got it|ok|close|dismiss|no thanks|continue)$/i;
  const scope = /cookie|consent|gdpr|privacy|banner|popup|modal|dialog|toast|app-?install|smart-?banner|download/i;
  let clicked = 0;
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a[href="#"], a[role="button"], input[type="button"]'));
  for (const el of nodes) {
    if (clicked >= 4) break;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    if (!label || label.length > 24 || !words.test(label)) continue;
    let p = el, inScope = false;
    for (let i = 0; p && i < 8; i++, p = p.parentElement) {
      const s = (p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : '') + ' ' + (p.getAttribute && (p.getAttribute('role') || '') + ' ' + (p.getAttribute('aria-label') || ''));
      if (scope.test(s)) { inScope = true; break; }
      const st = getComputedStyle(p);
      if (st.position === 'fixed' || st.position === 'sticky') { inScope = true; break; }
    }
    if (!inScope) continue;
    try { el.click(); clicked++; } catch (e) {}
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  let hidden = 0;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const st = getComputedStyle(el);
    if (st.position !== 'fixed' && st.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const area = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const s = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    const covers = area > vw * vh * 0.3;
    const banner = scope.test(s) && r.height < vh * 0.6;
    if (covers || banner) { el.style.setProperty('display', 'none', 'important'); hidden++; }
  }
  if (hidden) { document.documentElement.style.setProperty('overflow', 'auto', 'important'); document.body.style.setProperty('overflow', 'auto', 'important'); }
  return { clicked, hidden };
})()`;

/** 지연 로딩 이미지를 불러오려고 끝까지(상한 안에서) 내려 본 뒤 위로 돌아온다. 문서 높이를 돌려준다. */
const SCROLL_THROUGH = `(async () => {
  const max = ${POSTING_CAPTURE.maxHeight};
  const step = Math.max(400, Math.floor(window.innerHeight * 0.9));
  const started = Date.now();
  const height = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  for (let y = 0; y < Math.min(height(), max) && Date.now() - started < 6000; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 200));
  return height();
})()`;

const DESKTOP_UA_FALLBACK = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new PostingCaptureError("캡처 시간이 초과됐습니다. 다시 시도해 주세요.");
}

/** p를 기다리되 signal이 끊기면 바로 거절한다. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** 한 인스턴스에서 동시에 띄우는 브라우저 수(메모리). */
const MAX_CONCURRENT_BROWSERS = 2;
let running = 0;
const waiters: (() => void)[] = [];
async function acquireSlot(signal: AbortSignal): Promise<() => void> {
  while (running >= MAX_CONCURRENT_BROWSERS) {
    let wake!: () => void;
    const woken = new Promise<void>((r) => {
      wake = r;
    });
    waiters.push(wake);
    try {
      await raceAbort(woken, signal);
    } finally {
      // 시간 초과 등으로 그만 기다리면 대기열에서 빼야 다음 release()가 살아 있는 대기자를 깨운다.
      const i = waiters.indexOf(wake);
      if (i >= 0) waiters.splice(i, 1);
      // 깨워진 직후에 그만두면 받은 차례를 다음 대기자에게 넘긴다.
      else if (signal.aborted && running < MAX_CONCURRENT_BROWSERS) waiters.shift()?.();
    }
  }
  running++;
  return () => {
    running--;
    waiters.shift()?.();
  };
}

/** URL 한 개를 찍는다(저장하지 않는다). 실패는 PostingCaptureError(사용자에게 보여도 되는 문구). */
export async function capturePostingPage(url: string, deps: CaptureDeps = {}): Promise<CapturedImage> {
  // 첫 주소: fetch.ts와 같은 검사(형식·DNS·공개 주소).
  let target: URL;
  try {
    target = (await publicTarget(url, deps.lookup)).url;
  } catch (err) {
    if (err instanceof PostingFetchError || err instanceof PostingUrlError) throw new PostingCaptureError(err.message);
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new PostingCaptureError("캡처 시간이 초과됐습니다. 페이지가 너무 무겁거나 응답이 느립니다.")),
    POSTING_CAPTURE.totalTimeoutMs,
  );
  const outer = deps.signal;
  const onOuter = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuter, { once: true });
  const signal = controller.signal;

  const guard: HostGuard = createHostGuard(deps.lookup);
  let release: (() => void) | null = null;
  let browser: Browser | null = null;
  const proxy = await startEgressProxy({ guard, maxTransferBytes: POSTING_CAPTURE.maxTransferBytes });
  try {
    release = await acquireSlot(signal);
    browser = await raceAbort(launchBrowser(proxy.proxyUrl, deps), signal);
    const b = browser;
    signal.addEventListener("abort", () => void b.close().catch(() => {}), { once: true });

    // 쿠키·저장소가 남지 않는 새 컨텍스트.
    const context = await b.createBrowserContext();
    const page = await context.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    await page.setBypassServiceWorker(true);
    const ua = (await b.userAgent()).replace(/HeadlessChrome/g, "Chrome");
    await page.setUserAgent({ userAgent: ua.includes("Chrome/") ? ua : DESKTOP_UA_FALLBACK });
    await page.setExtraHTTPHeaders({ "accept-language": "ko-KR,ko;q=0.9,en;q=0.8" });
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));

    // 1차 거름망: 모든 요청(문서·하위 리소스·리다이렉트 각 단계)을 확인한다. 동영상·오디오는 받지 않는다.
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      void (async () => {
        const ok = !proxy.overLimit() && req.resourceType() !== "media" && (await isAllowedBrowserUrl(req.url(), guard));
        if (req.isInterceptResolutionHandled()) return;
        if (ok) await req.continue();
        else await req.abort("blockedbyclient");
      })().catch(() => {});
    });

    let response;
    try {
      response = await raceAbort(page.goto(target.href, { waitUntil: "domcontentloaded", timeout: POSTING_CAPTURE.navigationTimeoutMs }), signal);
    } catch (err) {
      if (signal.aborted) throw abortError(signal);
      console.warn("[capture] goto", (err as Error)?.message);
      throw new PostingCaptureError("원문 페이지를 열지 못했습니다. 페이지가 응답하지 않거나 접속을 막았습니다.");
    }
    if (!response) throw new PostingCaptureError("원문 페이지를 열지 못했습니다.");
    const status = response.status();
    if (status >= 400) throw new PostingCaptureError(`원문 페이지가 오류를 돌려줬습니다(HTTP ${status}).`);

    // 지연 로딩·SPA 렌더링을 잠깐 기다린다(끝까지 조용해지지 않는 페이지도 있어 시간만 쓴다).
    await raceAbort(page.waitForNetworkIdle({ idleTime: 600, timeout: 8_000 }).catch(() => {}), signal);
    await raceAbort(page.evaluate(DISMISS_BANNERS).catch(() => null), signal);
    const docHeight = Number(await raceAbort(page.evaluate(SCROLL_THROUGH).catch(() => POSTING_CAPTURE.viewportHeight), signal));
    await raceAbort(page.waitForNetworkIdle({ idleTime: 500, timeout: POSTING_CAPTURE.settleMs }).catch(() => {}), signal);
    // 스크롤로 나타난 배너를 한 번 더 닫는다.
    await raceAbort(page.evaluate(DISMISS_BANNERS).catch(() => null), signal);

    const plan = planCapture(docHeight);
    const type = plan.mime === "image/webp" ? "webp" : "jpeg";
    const shoot = (quality: number) =>
      raceAbort(
        page.screenshot({
          type,
          quality,
          clip: { x: 0, y: 0, width: POSTING_CAPTURE.viewportWidth, height: plan.height },
          captureBeyondViewport: true,
        }),
        signal,
      );
    let body = Buffer.from(await shoot(POSTING_CAPTURE.quality));
    if (body.length > POSTING_CAPTURE.maxBytes) body = Buffer.from(await shoot(45));
    if (body.length > POSTING_CAPTURE.maxBytes) throw new PostingCaptureError("캡처 이미지가 너무 큽니다.");
    if (body.length < 100) throw new PostingCaptureError(CAPTURE_GENERIC_ERROR);
    return { body, mime: plan.mime, width: POSTING_CAPTURE.viewportWidth, height: plan.height, clipped: plan.clipped };
  } catch (err) {
    if (signal.aborted) throw abortError(signal);
    if (err instanceof PostingCaptureError) throw err;
    console.error("[capture]", err);
    throw new PostingCaptureError(CAPTURE_GENERIC_ERROR);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
    await browser?.close().catch(() => {});
    release?.();
    await proxy.close();
  }
}

/** 오류 → 저장할 사용자용 문구. */
export function captureErrorMessage(err: unknown): string {
  if (err instanceof PostingCaptureError || err instanceof PostingFetchError || err instanceof PostingUrlError) return err.message;
  return CAPTURE_GENERIC_ERROR;
}

/**
 * 백그라운드 작업(after()): claimCapture → capturePostingPage → putObject → recordCaptureSuccess / recordCaptureFailure.
 * 맡을 작업이 없으면 바로 끝난다. 던지지 않는다.
 */
export async function runPostingCapture(sharedPostingId: string, deps: CaptureDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now;
  let claimed: Awaited<ReturnType<typeof claimCapture>>;
  try {
    claimed = await claimCapture(sharedPostingId, now());
  } catch (err) {
    console.error("[runPostingCapture] claim", sharedPostingId, err);
    return;
  }
  if (!claimed) return;
  const started = now();
  try {
    const shot = await (deps.capture ?? capturePostingPage)(claimed.url, deps);
    const key = postingCaptureKey(sharedPostingId, shot.mime);
    await putObject(key, shot.body, { contentType: shot.mime });
    // 형식이 바뀌었으면(webp ↔ jpg) 예전 파일을 지운다.
    const other = postingCaptureKey(sharedPostingId, shot.mime === "image/webp" ? "image/jpeg" : "image/webp");
    await deleteObject(other).catch(() => {});
    const saved = await recordCaptureSuccess(
      sharedPostingId,
      { key, mime: shot.mime, bytes: shot.body.length, width: shot.width, height: shot.height },
      now(),
    );
    console.info(
      `[runPostingCapture] ${sharedPostingId} ${saved ? "done" : "superseded"} ${shot.width}x${shot.height}${shot.clipped ? " (clipped)" : ""} ${shot.body.length}B ${now() - started}ms`,
    );
  } catch (err) {
    if (!(err instanceof PostingCaptureError)) console.error("[runPostingCapture]", sharedPostingId, err);
    else console.warn("[runPostingCapture]", sharedPostingId, err.message);
    await recordCaptureFailure(sharedPostingId, captureErrorMessage(err)).catch((e) => console.error("[runPostingCapture] record", e));
  }
}
