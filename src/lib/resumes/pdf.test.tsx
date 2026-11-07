import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { emptyResumeDocument, performanceScaffold, RESUME_TEMPLATE_IDS } from "@/lib/domain/resumes";
import { makeSampleResume } from "./__fixtures__/sample";
import { renderResumePdf } from "./pdf";

vi.mock("server-only", () => ({}));

const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 5)) === "%PDF-";

describe("renderResumePdf", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s 양식으로 PDF를 만든다", async (id) => {
    const pdf = await renderResumePdf(makeSampleResume(), id);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.byteLength).toBeGreaterThan(5_000);
    // 수동 확인용: RESUME_PDF_OUT=/tmp/dir npx vitest run src/lib/resumes/pdf.test.tsx
    if (process.env.RESUME_PDF_OUT) writeFileSync(`${process.env.RESUME_PDF_OUT}/resume-${id}.pdf`, pdf);
  }, 60_000);

  it.each(RESUME_TEMPLATE_IDS)("%s: 한 줄 소개가 있거나(최대 길이 포함) 없는 문서 모두 렌더링한다", async (id) => {
    const long = makeSampleResume();
    long.basics.tagline = "띄어쓰기없는한줄소개".repeat(20);
    expect(isPdf(await renderResumePdf(long, id))).toBe(true);
    const none = makeSampleResume();
    none.basics.tagline = "";
    none.basics.headline = "";
    expect(isPdf(await renderResumePdf(none, id))).toBe(true);
  }, 60_000);

  it.each(RESUME_TEMPLATE_IDS)("%s: 지원 동기가 있거나(최대 1500자, 여러 문단) 없는 문서 모두 렌더링한다", async (id) => {
    const doc = makeSampleResume();
    doc.motivation = Array.from({ length: 6 }, (_, i) => `${i + 1}문단 ${"지원동기문장".repeat(40)}`).join("\n\n").slice(0, 1500);
    const withIt = await renderResumePdf(doc, id);
    expect(isPdf(withIt)).toBe(true);
    const none = makeSampleResume();
    none.motivation = "";
    const without = await renderResumePdf(none, id);
    expect(isPdf(without)).toBe(true);
    expect(withIt.byteLength).toBeGreaterThan(without.byteLength);
  }, 60_000);

  it("빈 문서·긴 내용(여러 쪽)·띄어쓰기 없는 긴 한글도 렌더링한다", async () => {
    expect(isPdf(await renderResumePdf(emptyResumeDocument(), "developer"))).toBe(true);
    const doc = makeSampleResume();
    const longKo = "띄어쓰기없이아주길게이어지는한국어문장이좁은칸에서도줄바꿈되어야한다".repeat(3);
    doc.experience = Array.from({ length: 20 }, (_, i) => ({
      ...doc.experience[0]!,
      company: `회사 ${i + 1}`,
      bullets: Array.from({ length: 6 }, () => `${longKo} https://example.com/${"a".repeat(120)}`),
    }));
    const pdf = await renderResumePdf(doc, "compact");
    expect(isPdf(pdf)).toBe(true);
  }, 60_000);
});

describe("성과 중심 양식 PDF", () => {
  it("한글 문서·빈 뼈대·여러 쪽(항목 단위로 넘어감)을 렌더링한다", async () => {
    const full = makeSampleResume();
    expect(isPdf(await renderResumePdf(full, "performance"))).toBe(true);
    // 빈 칸은 찍지 않으므로 빈 뼈대도 오류 없이 만들어진다
    expect(isPdf(await renderResumePdf(performanceScaffold(), "performance"))).toBe(true);

    const long = makeSampleResume();
    long.projects = Array.from({ length: 8 }, (_, i) => ({
      ...long.projects[0]!,
      name: `프로젝트 ${i + 1}`,
      problem: "띄어쓰기없이아주길게이어지는한국어문장이좁은칸에서도줄바꿈되어야한다".repeat(4),
    }));
    // 한 쪽보다 긴 항목(쪼갤 수 있게 둔다)
    long.experience[0]!.bullets = Array.from({ length: 15 }, (_, i) => `${i + 1}. ${"아주 긴 기여 문장입니다. ".repeat(20)}`.slice(0, 500));
    const pdf = await renderResumePdf(long, "performance");
    expect(isPdf(pdf)).toBe(true);
    const pages = (new TextDecoder("latin1").decode(pdf).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    if (process.env.RESUME_PDF_OUT) writeFileSync(`${process.env.RESUME_PDF_OUT}/resume-performance-long.pdf`, pdf);
  }, 60_000);
});

describe("resumePdfFileName", () => {
  it("<이름>_<회사>_이력서.pdf, 위험한 문자는 빼고 RFC 5987로 내려간다", async () => {
    const { resumePdfFileName, pdfResponse } = await import("./http");
    expect(resumePdfFileName("홍길동", "페이랩")).toBe("홍길동_페이랩_이력서.pdf");
    expect(resumePdfFileName(" 홍 길동 ", "../a/b:c")).toBe("홍_길동_a_b_c_이력서.pdf");
    expect(resumePdfFileName("[ADD: 이름]", "")).toBe("이력서.pdf");
    expect(resumePdfFileName('a"\r\nb', "x;y")).toBe("a_b_x;y_이력서.pdf");
    const res = pdfResponse(new Uint8Array([37, 80, 68, 70]), resumePdfFileName("홍길동", "페이랩"));
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent("홍길동_페이랩_이력서.pdf")}`,
    );
  });
});

describe("쪽 나눔(긴 이력서)", () => {
  const pageCount = (pdf: Uint8Array) => (new TextDecoder("latin1").decode(pdf).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const longResume = () => {
    const doc = makeSampleResume();
    doc.experience = Array.from({ length: 10 }, (_, i) => ({
      ...doc.experience[0]!,
      company: `회사 ${i + 1}`,
      bullets: Array.from({ length: 5 }, (_, j) => `${j + 1}. 결제 API의 응답 시간을 측정하고 병목 구간을 개선해 처리량을 늘렸습니다.`),
    }));
    return doc;
  };

  it.each(RESUME_TEMPLATE_IDS)("%s 양식: 한 장을 넘는 이력서는 여러 쪽 PDF가 된다", async (id) => {
    const pdf = await renderResumePdf(longResume(), id);
    expect(pageCount(pdf)).toBeGreaterThan(1);
    if (process.env.RESUME_PDF_OUT) writeFileSync(`${process.env.RESUME_PDF_OUT}/resume-${id}-long.pdf`, pdf);
  }, 60_000);
});
