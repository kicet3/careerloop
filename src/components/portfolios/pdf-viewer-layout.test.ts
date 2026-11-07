import { describe, expect, it } from "vitest";
import { computePageLayout, currentPageIndex, parseContentRange, splitRange, zoomIn, zoomOut } from "./pdf-viewer-layout";

const A4 = { pageWidth: 595.28, pageHeight: 841.89 };

describe("computePageLayout", () => {
  it("폭 맞춤: 360px 화면(여백 뺀 344px)에서 쪽 폭 = 칸 폭, 비율 유지", () => {
    const l = computePageLayout({ ...A4, containerWidth: 344, zoom: 1, devicePixelRatio: 3 });
    expect(l.cssWidth).toBe(344);
    expect(l.cssHeight).toBe(Math.floor(841.89 * (344 / 595.28)));
    expect(l.pixelRatio).toBe(3);
    expect(l.canvasWidth).toBe(344 * 3);
    expect(l.scale).toBeCloseTo(344 / 595.28, 6);
  });

  it("확대는 폭 맞춤 배율에 곱한다", () => {
    const fit = computePageLayout({ ...A4, containerWidth: 800, zoom: 1 });
    const z2 = computePageLayout({ ...A4, containerWidth: 800, zoom: 2 });
    expect(z2.cssWidth).toBe(1600);
    expect(z2.scale).toBeCloseTo(fit.scale * 2, 6);
  });

  it("devicePixelRatio는 1~3으로 묶고, 캔버스 픽셀 수 상한을 넘으면 배율을 낮춘다", () => {
    expect(computePageLayout({ ...A4, containerWidth: 300, zoom: 1, devicePixelRatio: 0.5 }).pixelRatio).toBe(1);
    expect(computePageLayout({ ...A4, containerWidth: 300, zoom: 1, devicePixelRatio: 5 }).pixelRatio).toBe(3);
    const big = computePageLayout({ ...A4, containerWidth: 1200, zoom: 3, devicePixelRatio: 2, maxPixels: 4_000_000 });
    expect(big.canvasWidth * big.canvasHeight).toBeLessThanOrEqual(4_000_000);
    expect(big.pixelRatio).toBeLessThan(2);
  });

  it("잘못된 입력은 기본값(Letter·폭 1px·zoom 1)으로", () => {
    const l = computePageLayout({ pageWidth: 0, pageHeight: -1, containerWidth: 0, zoom: 0 });
    expect(l.cssWidth).toBe(1);
    expect(l.canvasWidth).toBeGreaterThanOrEqual(1);
  });
});

describe("zoom 단계", () => {
  it("올리고 내리며 양 끝에서 멈춘다", () => {
    expect(zoomIn(1)).toBe(1.25);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomIn(3)).toBe(3);
    expect(zoomOut(0.5)).toBe(0.5);
  });
});

describe("currentPageIndex", () => {
  it("화면 위 40% 지점을 지난 마지막 쪽", () => {
    const tops = [0, 1000, 2000, 3000];
    expect(currentPageIndex(tops, 0, 800)).toBe(0);
    expect(currentPageIndex(tops, 700, 800)).toBe(1);
    expect(currentPageIndex(tops, 2900, 800)).toBe(3);
    expect(currentPageIndex([], 100, 800)).toBe(0);
  });
});

describe("parseContentRange·splitRange", () => {
  it("Content-Range를 읽고 틀린 값은 null", () => {
    expect(parseContentRange("bytes 0-1023/5000")).toEqual({ start: 0, end: 1023, total: 5000 });
    expect(parseContentRange("bytes */5000")).toBeNull();
    expect(parseContentRange("bytes 10-5/5000")).toBeNull();
    expect(parseContentRange("bytes 0-5000/5000")).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });

  it("큰 구간을 조각으로", () => {
    expect(splitRange(0, 10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    expect(splitRange(5, 5, 4)).toEqual([]);
  });
});
