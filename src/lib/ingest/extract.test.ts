import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectKind, extractText, IngestError, MAX_UPLOAD_BYTES, normalizeText } from "./extract";

const enc = new TextEncoder();
const LONG = "홍길동 — 백엔드 개발자. Kotlin, Spring Boot, PostgreSQL로 결제 시스템을 3년간 운영했습니다.";

/** Helvetica 한 줄짜리 최소 PDF를 만든다(xref 오프셋 계산 포함). */
function tinyPdf(line: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}

describe("normalizeText", () => {
  it("NFC 정규화, CRLF 통일, 빈 줄 축소, 앞뒤 공백 제거", () => {
    const nfd = "한글".normalize("NFD");
    const out = normalizeText(`﻿  ${nfd}  \r\n\r\n\r\n\r\n둘째 줄\t \n\n\n\n셋째  `);
    expect(out).toBe("한글\n\n둘째 줄\n\n셋째");
    expect(out.startsWith("한글".normalize("NFC"))).toBe(true);
  });
});

describe("detectKind", () => {
  it("확장자 우선, 없으면 MIME", () => {
    expect(detectKind("cv.PDF", "")).toBe("pdf");
    expect(detectKind("cv.docx", "application/octet-stream")).toBe("docx");
    expect(detectKind("cv.md", "")).toBe("text");
    expect(detectKind("cv", "text/plain; charset=utf-8")).toBe("text");
    expect(detectKind("cv.hwp", "application/pdf")).toBeNull();
    expect(detectKind("cv.doc", "")).toBeNull();
  });
});

describe("extractText", () => {
  it("TXT를 UTF-8로 읽고 정규화한다", async () => {
    const r = await extractText({ name: "resume.txt", type: "text/plain", bytes: enc.encode(`${LONG}\n\n\n\n끝`) });
    expect(r.text).toBe(`${LONG}\n\n끝`);
    expect(r.warnings).toEqual([]);
  });

  it("지원하지 않는 형식은 415 IngestError", async () => {
    const p = extractText({ name: "resume.hwp", type: "application/x-hwp", bytes: enc.encode(LONG) });
    await expect(p).rejects.toBeInstanceOf(IngestError);
    await expect(p).rejects.toMatchObject({ status: 415 });
  });

  it("10MB 초과는 413", async () => {
    const p = extractText({ name: "a.txt", type: "text/plain", bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) });
    await expect(p).rejects.toMatchObject({ status: 413 });
  });

  it("50자 미만이면 붙여넣기를 권하는 오류", async () => {
    await expect(extractText({ name: "a.md", type: "", bytes: enc.encode("짧음") })).rejects.toThrow(/붙여넣어/);
  });

  it("PDF 텍스트를 추출한다", async () => {
    const line = "Jane Doe - Backend Engineer. Built payment systems in Kotlin and Spring Boot for 3 years.";
    const r = await extractText({ name: "cv.pdf", type: "application/pdf", bytes: tinyPdf(line) });
    expect(r.text).toContain("Backend Engineer");
  });

  it("ToUnicode 없는 한국어 CID 글꼴 PDF(macOS 인쇄 PDF)도 한글을 읽는다 — pdfjs-dist CMap 필요", async () => {
    const bytes = new Uint8Array(readFileSync(path.join(import.meta.dirname, "__fixtures__", "korean-cid.pdf")));
    const r = await extractText({ name: "resume.pdf", type: "application/pdf", bytes });
    expect(r.text).toContain("김민준");
    expect(r.text).toContain("주식회사 페이랩");
  });

  it("텍스트가 없는 PDF는 이미지 PDF 안내", async () => {
    await expect(extractText({ name: "cv.pdf", type: "application/pdf", bytes: tinyPdf("") })).rejects.toThrow(
      /이미지 PDF/,
    );
  });
});
