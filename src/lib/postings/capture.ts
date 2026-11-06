import "server-only";
/**
 * 공고 원문 전체 페이지 캡처. 헤드리스 Chromium으로 공고 페이지를 열어 한 장의 WebP(높이가 WebP 한계를 넘으면 JPEG)로 찍는다.
 *
 * - 브라우저 실행·SSRF 방어(첫 주소 검사·출구 프록시·요청 가로채기)·동시 실행 상한은 browser.ts withGuardedPage(공고를 브라우저로
 *   열어 읽는 render.ts와 공용). 브라우저가 없으면 PostingCaptureError.
 * - POSTING_CAPTURE: 폭 1280, 높이 상한 20000px, 품질 70, 탐색 25초·전체 75초, 전송량 25MB, 이미지 8MB.
 * - 쿠키·앱 설치 배너는 흔한 '동의'·'닫기' 버튼을 눌러 보고, 화면을 크게 덮는 고정 요소는 숨긴다(실패해도 계속).
 * - runPostingCapture: claimCapture → capturePostingPage → putObject(postingCaptureKey) → recordCaptureSuccess / recordCaptureFailure.
 *   실패 문구는 사용자에게 보여도 되는 한국어만 저장한다(내부 주소·스택은 로그에만).
 */
import type { ResourceType } from "puppeteer-core";
import { POSTING_CAPTURE, type PostingCaptureMime } from "@/lib/domain/posting-capture";
import { deleteObject, putObject } from "@/lib/storage";
import { withGuardedPage } from "./browser";
import { claimCapture, postingCaptureKey, recordCaptureFailure, recordCaptureSuccess } from "./capture-store";
import { PostingFetchError, type LookupFn } from "./fetch";
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

/** 찍을 높이·형식(순수). 문서 높이를 상한으로 자르고, WebP 한계를 넘으면 JPEG. */
export function planCapture(documentHeight: number): { height: number; mime: PostingCaptureMime; clipped: boolean } {
  const h = Math.max(1, Math.ceil(Number.isFinite(documentHeight) ? documentHeight : POSTING_CAPTURE.viewportHeight));
  const height = Math.min(h, POSTING_CAPTURE.maxHeight);
  return { height, mime: height > WEBP_MAX_DIMENSION ? "image/jpeg" : "image/webp", clipped: h > POSTING_CAPTURE.maxHeight };
}

// 브라우저 실행·SSRF 거름망·세마포어는 browser.ts(열어 읽기 render.ts와 공용). 예전 경로로 쓰던 이름은 그대로 내보낸다.
export { hardenedArgs, localChromePath, MAC_CHROME_PATH } from "./browser";

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

const CAPTURE_MEDIA_BLOCK: ReadonlySet<ResourceType> = new Set(["media"]);

/** URL 한 개를 찍는다(저장하지 않는다). 실패는 PostingCaptureError(사용자에게 보여도 되는 문구). */
export async function capturePostingPage(url: string, deps: CaptureDeps = {}): Promise<CapturedImage> {
  return withGuardedPage(
    url,
    {
      lookup: deps.lookup,
      executablePath: deps.executablePath,
      signal: deps.signal,
      totalTimeoutMs: POSTING_CAPTURE.totalTimeoutMs,
      maxTransferBytes: POSTING_CAPTURE.maxTransferBytes,
      // 동영상·오디오는 받지 않는다.
      blockedResourceTypes: CAPTURE_MEDIA_BLOCK,
      error: (message) => new PostingCaptureError(message),
      isOwnError: (err): err is PostingCaptureError => err instanceof PostingCaptureError,
      messages: { noBrowser: NO_BROWSER, timeout: "캡처 시간이 초과됐습니다. 페이지가 너무 무겁거나 응답이 느립니다.", generic: CAPTURE_GENERIC_ERROR },
      logTag: "capture",
    },
    async ({ page, target, signal, race }) => {
      let response;
      try {
        response = await race(page.goto(target.href, { waitUntil: "domcontentloaded", timeout: POSTING_CAPTURE.navigationTimeoutMs }));
      } catch (err) {
        if (signal.aborted) throw err;
        console.warn("[capture] goto", (err as Error)?.message);
        throw new PostingCaptureError("원문 페이지를 열지 못했습니다. 페이지가 응답하지 않거나 접속을 막았습니다.");
      }
      if (!response) throw new PostingCaptureError("원문 페이지를 열지 못했습니다.");
      const status = response.status();
      if (status >= 400) throw new PostingCaptureError(`원문 페이지가 오류를 돌려줬습니다(HTTP ${status}).`);

      // 지연 로딩·SPA 렌더링을 잠깐 기다린다(끝까지 조용해지지 않는 페이지도 있어 시간만 쓴다).
      await race(page.waitForNetworkIdle({ idleTime: 600, timeout: 8_000 }).catch(() => {}));
      await race(page.evaluate(DISMISS_BANNERS).catch(() => null));
      const docHeight = Number(await race(page.evaluate(SCROLL_THROUGH).catch(() => POSTING_CAPTURE.viewportHeight)));
      await race(page.waitForNetworkIdle({ idleTime: 500, timeout: POSTING_CAPTURE.settleMs }).catch(() => {}));
      // 스크롤로 나타난 배너를 한 번 더 닫는다.
      await race(page.evaluate(DISMISS_BANNERS).catch(() => null));

      const plan = planCapture(docHeight);
      const type = plan.mime === "image/webp" ? "webp" : "jpeg";
      const shoot = (quality: number) =>
        race(
          page.screenshot({
            type,
            quality,
            clip: { x: 0, y: 0, width: POSTING_CAPTURE.viewportWidth, height: plan.height },
            captureBeyondViewport: true,
          }),
        );
      let body = Buffer.from(await shoot(POSTING_CAPTURE.quality));
      if (body.length > POSTING_CAPTURE.maxBytes) body = Buffer.from(await shoot(45));
      if (body.length > POSTING_CAPTURE.maxBytes) throw new PostingCaptureError("캡처 이미지가 너무 큽니다.");
      if (body.length < 100) throw new PostingCaptureError(CAPTURE_GENERIC_ERROR);
      return { body, mime: plan.mime, width: POSTING_CAPTURE.viewportWidth, height: plan.height, clipped: plan.clipped };
    },
  );
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
