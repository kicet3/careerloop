import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeSampleReport } from "./__fixtures__/sample";
import { renderReportPdf, splitForWrap } from "./pdf";
import type { ReportModel } from "./types";

const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5)) === "%PDF-";

describe("splitForWrap", () => {
  it("짧은 단어는 그대로 두고, 띄어쓰기 없는 긴 한글은 글자 단위로 끊을 수 있게 한다", () => {
    expect(splitForWrap("데이터")).toEqual(["데이터"]);
    expect(splitForWrap("Kubernetes")).toEqual(["Kubernetes"]);
    const parts = splitForWrap("가나다라마바사아자차카타");
    expect(parts.filter(Boolean).join("")).toBe("가나다라마바사아자차카타");
    expect(parts).toContain("");
  });
});

describe("renderReportPdf", () => {
  it("샘플 보고서를 PDF로 렌더링한다", async () => {
    const pdf = await renderReportPdf(makeSampleReport());
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.byteLength).toBeGreaterThan(10_000);
    // 수동 확인용: PDF_SAMPLE_OUT=/path/sample.pdf npx vitest run src/lib/report/pdf.test.tsx
    if (process.env.PDF_SAMPLE_OUT) writeFileSync(process.env.PDF_SAMPLE_OUT, pdf);
  }, 60_000);

  it("부분 결과·추정 JD·띄어쓰기 없는 긴 한글·긴 URL도 렌더링한다", async () => {
    const base = makeSampleReport();
    const longKo = "띄어쓰기없이아주길게이어지는한국어문장이표의좁은칸에서도줄바꿈되어야한다".repeat(4);
    const r: ReportModel = {
      ...base,
      meta: { ...base.meta, title: longKo, completedAt: null },
      summary: { ...base.summary, headline: longKo, matchScore: null, atsAfter: null, closestToReject: null },
      jd: base.jd
        ? { ...base.jd, analysis: { ...base.jd.analysis, source: "inferred", summary: `https://example.com/${"a".repeat(200)}` } }
        : null,
      plan: null,
      rewrite: null,
      mistakes: base.mistakes.map((m) => ({ ...m, why: longKo })),
    };
    const pdf = await renderReportPdf(r);
    expect(isPdf(pdf)).toBe(true);
    if (process.env.PDF_STRESS_OUT) writeFileSync(process.env.PDF_STRESS_OUT, pdf);
  }, 60_000);
});
