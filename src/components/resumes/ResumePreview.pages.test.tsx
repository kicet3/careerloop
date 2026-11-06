import { describe, expect, it } from "vitest";
import { RESUME_TEMPLATE_IDS, RESUME_TEMPLATES } from "@/lib/domain/resumes";
import { makeSampleResume } from "@/lib/resumes/__fixtures__/sample";
import { A4, ptToPx } from "@/lib/resumes/pagination";
import { buildModel, computePages } from "./ResumePreview";

/** 경력 8건 × 불릿 5개의 긴 이력서. */
function longResume() {
  const doc = makeSampleResume();
  const base = doc.experience[0]!;
  doc.experience = Array.from({ length: 8 }, (_, i) => ({
    ...base,
    company: `회사${i}`,
    bullets: Array.from({ length: 5 }, (_, j) => `성과 ${i}-${j}`),
  }));
  return doc;
}

const ids = (RESUME_TEMPLATE_IDS as readonly string[]).filter((id) => id !== "performance") as (typeof RESUME_TEMPLATE_IDS)[number][];

describe("ResumePreview 쪽 나눔(computePages, 높이를 직접 넣어)", () => {
  it.each(ids)("%s: 긴 이력서는 여러 쪽, 모든 블록이 순서대로 한 번씩, 쪽마다 본문 높이 안", (id) => {
    const model = buildModel(longResume(), id);
    const H = 40;
    const heights = new Map([...model.main, ...model.side].map((a) => [a.id, H]));
    const headerH = 90;
    if (model.header) heights.set(model.header.id, headerH);
    const pages = computePages(model, heights);
    expect(pages.main.length).toBeGreaterThan(1);
    expect(pages.main.flat()).toEqual(model.main.map((a) => a.id));
    expect(pages.side.flat()).toEqual(model.side.map((a) => a.id));
    expect(pages.extra.every((x) => x === 0)).toBe(true);

    const g = model.geo;
    const pageH = ptToPx(g.contentHeight);
    const headerTotal = model.header ? headerH + ptToPx(model.headerAfterPt) : 0;
    const gap = new Map([...model.main, ...model.side].map((a) => [a.id, ptToPx(a.gapPt)]));
    const used = (p: string[]) => p.reduce((s, id, i) => s + H + (i === 0 ? 0 : gap.get(id)!), 0);
    pages.main.forEach((p, i) => expect(used(p)).toBeLessThanOrEqual((i === 0 ? pageH - headerTotal : pageH) + 0.5));
    // 사이드바 옆 열: 첫 쪽은 머리글과 옆 열 위아래 안쪽 여백을 뺀 높이
    const inset = ptToPx(g.side.padY * 2);
    pages.side.forEach((p, i) => expect(used(p)).toBeLessThanOrEqual((i === 0 ? pageH - headerTotal - inset : pageH - inset) + 0.5));
    expect(RESUME_TEMPLATES[id].style.layout === "sidebar").toBe(model.header !== null);
  });

  it("쪽 본문 높이는 A4에서 위아래 여백을 뺀 값", () => {
    const g = buildModel(longResume(), "developer").geo;
    expect(ptToPx(g.contentHeight) + ptToPx(g.padY * 2)).toBeCloseTo(A4.heightPx, 5);
  });

  it("나눌 수 없는 블록 하나가 한 쪽보다 크면 그 쪽만 늘린다(extra)", () => {
    const model = buildModel(longResume(), ids[0]!);
    const heights = new Map(model.main.map((a) => [a.id, 10]));
    const pageH = ptToPx(model.geo.contentHeight);
    const big = model.main[model.main.length - 1]!;
    heights.set(big.id, pageH + 200);
    const pages = computePages(model, heights);
    const p = pages.main.findIndex((q) => q.includes(big.id));
    expect(pages.main[p]).toEqual([big.id]);
    expect(pages.extra[p]).toBeCloseTo(200, 5);
    expect(pages.extra.filter((_, i) => i !== p).every((x) => x === 0)).toBe(true);
  });
});
