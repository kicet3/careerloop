/** 포트폴리오 업로드 형식(화면 공용): PDF만 — accept 값, 확장자 검사 문구, 보내기 전 %PDF- 확인. 이력서 업로드 형식은 그대로. */
import { describe, expect, it } from "vitest";
import { UPLOAD_ACCEPT, validateUpload } from "@/components/app/FileDrop";
import { makeTestPdf } from "@/test/pdf";
import {
  checkPortfolioPdf,
  hasPdfSignature,
  PORTFOLIO_NOT_PDF_CONTENT_MESSAGE,
  PORTFOLIO_PDF_ONLY_MESSAGE,
  PORTFOLIO_UPLOAD_ACCEPT,
  PORTFOLIO_UPLOAD_ACCEPT_ATTR,
} from "./portfolios";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("포트폴리오 업로드 형식(PDF만)", () => {
  it("화면 accept는 PDF 하나(확장자 + MIME), 이력서 업로드 목록은 그대로", () => {
    expect(PORTFOLIO_UPLOAD_ACCEPT).toEqual([".pdf"]);
    expect(PORTFOLIO_UPLOAD_ACCEPT_ATTR).toBe(".pdf,application/pdf");
    expect(PORTFOLIO_PDF_ONLY_MESSAGE).toContain("포트폴리오 파일은 PDF만 올릴 수 있습니다");
    expect(UPLOAD_ACCEPT).toEqual([".pdf", ".docx", ".hwp", ".hwpx", ".html", ".htm", ".txt", ".md"]);
  });

  it("고를 때 PDF가 아니면 PDF만 안내(DOC 안내보다 앞선다), PDF는 통과", () => {
    const file = (name: string) => new File(["x"], name);
    for (const n of ["a.docx", "a.hwp", "a.png", "a.jpg", "a.txt", "a.doc", "a"]) {
      expect(validateUpload(file(n), PORTFOLIO_UPLOAD_ACCEPT, 1024, PORTFOLIO_PDF_ONLY_MESSAGE)).toBe(PORTFOLIO_PDF_ONLY_MESSAGE);
    }
    expect(validateUpload(file("포트폴리오.PDF"), PORTFOLIO_UPLOAD_ACCEPT, 1024, PORTFOLIO_PDF_ONLY_MESSAGE)).toBeNull();
    // 이력서 쪽(typeError 없이)은 예전 문구 그대로
    expect(validateUpload(file("cv.doc"), UPLOAD_ACCEPT)).toMatch(/DOCX나 PDF/);
    expect(validateUpload(file("cv.hwp"), UPLOAD_ACCEPT)).toBeNull();
  });

  it("PDF 표식(%PDF-)은 앞 1024바이트 안에서 찾는다", () => {
    expect(hasPdfSignature(new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(hasPdfSignature(new TextEncoder().encode("   %PDF-1.4"))).toBe(true);
    expect(hasPdfSignature(PNG)).toBe(false);
    expect(hasPdfSignature(new Uint8Array([...new Uint8Array(1100), ...new TextEncoder().encode("%PDF-")]))).toBe(false);
  });

  it("보내기 전 확인: 진짜 PDF는 통과, 확장자만 .pdf인 PNG는 내용 안내", async () => {
    expect(await checkPortfolioPdf(new File([makeTestPdf("결제 정산")], "a.pdf"))).toBeNull();
    expect(await checkPortfolioPdf(new File([PNG], "renamed.pdf"))).toBe(PORTFOLIO_NOT_PDF_CONTENT_MESSAGE);
  });
});
