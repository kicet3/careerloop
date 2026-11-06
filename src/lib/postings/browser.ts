import "server-only";
/**
 * 공고 페이지를 여는 헤드리스 Chromium 공용 코드 — 원문 캡처(capture.ts)와 브라우저로 열어 읽기(render.ts)가 함께 쓴다.
 *
 * - 브라우저: Vercel·Lambda(process.env.VERCEL / AWS_LAMBDA_FUNCTION_NAME)는 @sparticuz/chromium + puppeteer-core,
 *   그 밖에는 CHROME_PATH, darwin이면 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome". 없으면 noBrowser 오류.
 * - SSRF(fetch.ts와 같은 규칙): 첫 주소는 publicTarget으로 확인한다. 브라우저의 모든 네트워크(하위 리소스·리다이렉트·웹소켓·
 *   서비스 워커 포함)는 capture-egress.ts의 프록시만 지나며, 프록시가 호스트를 다시 확인하고 검사한 IP로만 연결한다(DNS 고정).
 *   요청 가로채기(setRequestInterception)는 그 앞의 1차 거름망 — 허용하지 않는 스킴·호스트·포트·자원 종류는 abort한다.
 * - 우회하지 않는다: 스텔스 플러그인·지문 위장·검사 풀기·프록시 우회를 쓰지 않는다. User-Agent는 실제 브라우저 값에서
 *   'HeadlessChrome'만 'Chrome'으로 바꾼 것(캡처와 같다).
 * - 한 인스턴스에서 동시에 띄우는 브라우저는 MAX_CONCURRENT_BROWSERS개(캡처·열어 읽기 공용 세마포어).
 * - 쿠키·저장소가 남지 않는 새 컨텍스트, 다운로드 금지, 서비스 워커 우회, 대화상자 닫기. 끝나면 브라우저·프록시를 항상 닫는다.
 */
import { existsSync } from "node:fs";
import type { Browser, HTTPRequest, LaunchOptions, Page, ResourceType } from "puppeteer-core";
import { POSTING_CAPTURE } from "@/lib/domain/posting-capture";
import { createHostGuard, isAllowedBrowserUrl, startEgressProxy, type EgressProxy, type HostGuard } from "./capture-egress";
import { PostingFetchError, publicTarget, type LookupFn } from "./fetch";
import { PostingUrlError } from "./url";

export const MAC_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

/** 브라우저가 없을 때(로컬에 Chrome이 없는 환경). */
export class NoBrowserError extends Error {
  constructor() {
    super("브라우저가 없습니다.");
    this.name = "NoBrowserError";
  }
}

async function launchBrowser(proxyUrl: string, opts: { executablePath?: string; protocolTimeoutMs: number }): Promise<Browser> {
  const { default: puppeteer } = await import("puppeteer-core");
  const base: LaunchOptions = {
    pipe: true,
    defaultViewport: { width: POSTING_CAPTURE.viewportWidth, height: POSTING_CAPTURE.viewportHeight, deviceScaleFactor: 1 },
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    protocolTimeout: opts.protocolTimeoutMs,
    timeout: 30_000,
  };
  if (opts.executablePath) {
    return puppeteer.launch({ ...base, executablePath: opts.executablePath, headless: true, args: hardenedArgs(proxyUrl) });
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
  if (!local) throw new NoBrowserError();
  return puppeteer.launch({ ...base, executablePath: local, headless: true, args: hardenedArgs(proxyUrl) });
}

const DESKTOP_UA_FALLBACK = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** p를 기다리되 signal이 끊기면 바로 거절한다(signal.reason이 Error면 그것, 아니면 fallback()). */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal, fallback: () => Error = () => new Error("aborted")): Promise<T> {
  const reason = () => (signal.reason instanceof Error ? signal.reason : fallback());
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
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

/** 한 인스턴스에서 동시에 띄우는 브라우저 수(메모리). 캡처와 열어 읽기가 함께 센다. */
export const MAX_CONCURRENT_BROWSERS = 2;
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
  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    waiters.shift()?.();
  };
}

export interface GuardedPageOptions<E extends Error> {
  lookup?: LookupFn;
  executablePath?: string;
  /** 호출자 취소(가져오기 작업 전체 시간 상한 등). 끊기면 그 reason을 그대로 던진다. */
  signal?: AbortSignal;
  /** 브라우저 실행부터 끝까지의 마감. */
  totalTimeoutMs: number;
  /** 페이지가 받는 전체 응답 상한(프록시). */
  maxTransferBytes: number;
  /** 받지 않을 자원 종류(예: 캡처는 media, 열어 읽기는 image·media·font). */
  blockedResourceTypes: ReadonlySet<ResourceType>;
  /** 사용자에게 보여도 되는 오류를 만든다(첫 주소 검사 실패·브라우저 없음·시간 초과·알 수 없는 오류). */
  error: (message: string) => E;
  isOwnError: (err: unknown) => err is E;
  messages: { noBrowser: string; timeout: string; generic: string };
  /** 로그 접두어. */
  logTag: string;
  /** 브라우저 실행(테스트 주입용). 기본은 서버리스 @sparticuz/chromium 또는 로컬 Chrome. */
  launch?: (proxyUrl: string, opts: { executablePath?: string; protocolTimeoutMs: number }) => Promise<Browser>;
}

export interface GuardedPageContext {
  page: Page;
  /** 첫 주소(publicTarget 검사를 통과한 것). */
  target: URL;
  /** 마감·호출자 취소를 합친 신호. */
  signal: AbortSignal;
  proxy: EgressProxy;
  /** p를 기다리되 마감·취소면 바로 거절한다. */
  race: <T>(p: Promise<T>) => Promise<T>;
}

/**
 * 첫 주소 검사 → 출구 프록시 → 세마포어 → 브라우저 실행 → 새 컨텍스트·페이지 설정(요청 가로채기) → run(page) → 모두 닫기.
 * 오류: run이 던진 사용자용 오류(isOwnError)는 그대로, 마감은 messages.timeout, 호출자 취소는 그 reason, 그 밖은 messages.generic.
 */
export async function withGuardedPage<T, E extends Error>(url: string, opts: GuardedPageOptions<E>, run: (ctx: GuardedPageContext) => Promise<T>): Promise<T> {
  // 첫 주소: fetch.ts와 같은 검사(형식·DNS·공개 주소).
  let target: URL;
  try {
    target = (await publicTarget(url, opts.lookup)).url;
  } catch (err) {
    if (err instanceof PostingFetchError || err instanceof PostingUrlError) throw opts.error(err.message);
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(opts.error(opts.messages.timeout)), opts.totalTimeoutMs);
  const outer = opts.signal;
  const onOuter = () => controller.abort(outer?.reason);
  if (outer?.aborted) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  const signal = controller.signal;
  const timeoutError = () => opts.error(opts.messages.timeout);
  const race = <R>(p: Promise<R>) => raceAbort(p, signal, timeoutError);

  const guard: HostGuard = createHostGuard(opts.lookup);
  let release: (() => void) | null = null;
  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  const proxy = await startEgressProxy({ guard, maxTransferBytes: opts.maxTransferBytes });
  try {
    release = await race(acquireSlot(signal));
    launching = (opts.launch ?? launchBrowser)(proxy.proxyUrl, { executablePath: opts.executablePath, protocolTimeoutMs: opts.totalTimeoutMs });
    browser = await race(launching);
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

    // 1차 거름망: 모든 요청(문서·하위 리소스·리다이렉트 각 단계)을 확인한다.
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      if (req.isInterceptResolutionHandled()) return;
      void (async () => {
        const ok = !proxy.overLimit() && !opts.blockedResourceTypes.has(req.resourceType()) && (await isAllowedBrowserUrl(req.url(), guard));
        if (req.isInterceptResolutionHandled()) return;
        if (ok) await req.continue();
        else await req.abort("blockedbyclient");
      })().catch(() => {});
    });

    return await run({ page, target, signal, proxy, race });
  } catch (err) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : timeoutError();
    if (opts.isOwnError(err)) throw err;
    if (err instanceof NoBrowserError) throw opts.error(opts.messages.noBrowser);
    console.error(`[${opts.logTag}]`, err);
    throw opts.error(opts.messages.generic);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuter);
    if (browser) {
      await browser.close().catch(() => {});
      release?.();
    } else if (launching) {
      // 마감·취소가 브라우저 실행 도중에 나면 race만 끝나고 Chromium은 계속 뜬다 — 다 뜨면 닫고, 닫힌 뒤에야 차례를 돌려준다
      // (그래야 MAX_CONCURRENT_BROWSERS가 실제 프로세스 수를 센다). 오류는 이미 던졌으니 기다리지 않는다.
      const late = release;
      void launching
        .then((b) => b.close(), () => {})
        .catch(() => {})
        .finally(() => late?.());
    } else {
      release?.();
    }
    await proxy.close();
  }
}
