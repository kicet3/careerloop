/**
 * PdfViewer의 순수 계산(브라우저 API 없음 — 테스트한다): 쪽 크기(폭 맞춤·확대·devicePixelRatio·캔버스 픽셀 상한), 지금 보는 쪽,
 * Range 응답의 Content-Range 읽기, 큰 구간을 조각으로 나누기.
 */

/** 확대 단계(1 = 폭 맞춤). */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const FIT_ZOOM = 1;

export function zoomIn(zoom: number): number {
  return ZOOM_LEVELS.find((z) => z > zoom + 1e-6) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
}

export function zoomOut(zoom: number): number {
  return [...ZOOM_LEVELS].reverse().find((z) => z < zoom - 1e-6) ?? ZOOM_LEVELS[0];
}

/**
 * 캔버스 한 장의 픽셀 수 상한. iOS Safari는 캔버스 한 장 16.7M 픽셀·전체 메모리에 묶인다 — 화면 밖 쪽은 지우고(PdfViewer) 한 장도 이 아래로.
 */
export const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;

export interface PageLayout {
  /** pdf.js getViewport의 scale(CSS 픽셀 기준). */
  scale: number;
  cssWidth: number;
  cssHeight: number;
  /** 캔버스 픽셀 / CSS 픽셀. */
  pixelRatio: number;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * 쪽 하나의 화면 크기. pageWidth·pageHeight: scale 1 viewport 크기(PDF 포인트, 회전 반영).
 * 폭 맞춤(zoom 1)은 쪽 폭 = containerWidth. 캔버스는 devicePixelRatio(1~3)만큼 촘촘하게, 단 픽셀 수는 maxPixels 아래로.
 */
export function computePageLayout(input: {
  pageWidth: number;
  pageHeight: number;
  containerWidth: number;
  zoom: number;
  devicePixelRatio?: number;
  maxPixels?: number;
}): PageLayout {
  const pageWidth = input.pageWidth > 0 ? input.pageWidth : 612;
  const pageHeight = input.pageHeight > 0 ? input.pageHeight : 792;
  const containerWidth = Math.max(1, Math.floor(input.containerWidth));
  const zoom = input.zoom > 0 ? input.zoom : FIT_ZOOM;
  const scale = (containerWidth / pageWidth) * zoom;
  const cssWidth = Math.max(1, Math.floor(pageWidth * scale));
  const cssHeight = Math.max(1, Math.floor(pageHeight * scale));
  const dpr = Math.min(3, Math.max(1, Number.isFinite(input.devicePixelRatio) ? input.devicePixelRatio! : 1));
  const maxPixels = input.maxPixels ?? MAX_CANVAS_PIXELS;
  const pixelRatio = Math.min(dpr, Math.sqrt(maxPixels / (cssWidth * cssHeight)));
  return {
    scale,
    cssWidth,
    cssHeight,
    pixelRatio,
    canvasWidth: Math.max(1, Math.floor(cssWidth * pixelRatio)),
    canvasHeight: Math.max(1, Math.floor(cssHeight * pixelRatio)),
  };
}

/**
 * 지금 보는 쪽(0부터). tops: 스크롤 칸 안 각 쪽의 위쪽 위치(오름차순). 화면 위에서 40% 지점을 지난 마지막 쪽.
 */
export function currentPageIndex(tops: readonly number[], scrollTop: number, viewportHeight: number): number {
  if (tops.length === 0) return 0;
  const line = scrollTop + viewportHeight * 0.4;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! <= line) idx = i;
    else break;
  }
  return idx;
}

/** "bytes 0-1023/5000" → { start, end(포함), total }. 형식이 틀리면 null. */
export function parseContentRange(header: string | null): { start: number; end: number; total: number } | null {
  const m = header ? /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(header.trim()) : null;
  if (!m) return null;
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (end < start || end >= total) return null;
  return { start, end, total };
}

/** [begin, end) 구간을 길이 max 이하 조각들로(begin 기준으로 max 배수 경계). */
export function splitRange(begin: number, end: number, max: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const step = Math.max(1, Math.floor(max));
  for (let b = begin; b < end; b += step) out.push([b, Math.min(end, b + step)]);
  return out;
}
