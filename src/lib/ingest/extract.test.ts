import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  assertDocxWithinLimits,
  detectKind,
  extractText,
  IngestError,
  MAX_DOCX_ENTRY_BYTES,
  MAX_PDF_PAGES,
  MAX_UPLOAD_BYTES,
  normalizeText,
} from "./extract";

const enc = new TextEncoder();
const LONG = "홍길동 — 백엔드 개발자. Kotlin, Spring Boot, PostgreSQL로 결제 시스템을 3년간 운영했습니다.";

/** Helvetica 한 줄짜리 최소 PDF를 만든다(xref 오프셋 계산 포함). pages > 1이면 같은 줄을 여러 쪽에 넣는다. */
function tinyPdf(line: string, pages = 1): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  // 1: Catalog, 2: Pages, 3: Font, 4: Contents, 5..: Page
  const kids = Array.from({ length: pages }, (_, i) => `${i + 5} 0 R`).join(" ");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ...Array.from(
      { length: pages },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    ),
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

// ---------------------------------------------------------------------------
// 크기·시간 제한 (zip bomb, 대형 PDF)
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 최소 ZIP 작성기(deflate). declaredSize로 중앙 디렉터리의 크기를 거짓으로 적을 수 있다. */
function makeZip(entries: { name: string; data: Buffer; declaredSize?: number }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = deflateRawSync(e.data);
    const size = e.declaredSize ?? e.data.length;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

function docx(documentXml: string | Buffer, declaredSize?: number): Uint8Array {
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    { name: "word/document.xml", data: Buffer.isBuffer(documentXml) ? documentXml : Buffer.from(documentXml), declaredSize },
  ]);
}

const DOC_XML = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${LONG}</w:t></w:r></w:p></w:body></w:document>`;

describe("추출 제한", () => {
  it("정상 DOCX는 통과하고 텍스트를 읽는다", async () => {
    const bytes = docx(DOC_XML);
    expect(() => assertDocxWithinLimits(bytes)).not.toThrow();
    const r = await extractText({ name: "cv.docx", type: "", bytes });
    expect(r.text).toContain("결제 시스템");
  });

  it("압축을 풀면 상한을 넘는 DOCX(zip bomb)는 413 — 선언 크기가 거짓이어도 실제로 풀어 보고 막는다", async () => {
    const bomb = Buffer.alloc(MAX_DOCX_ENTRY_BYTES + 1024, 0x20);
    for (const declared of [undefined, 1000]) {
      const bytes = docx(bomb, declared);
      expect(bytes.byteLength).toBeLessThan(200_000); // 압축률이 매우 높은 파일
      expect(() => assertDocxWithinLimits(bytes)).toThrow(IngestError);
      await expect(extractText({ name: "cv.docx", type: "", bytes })).rejects.toMatchObject({ status: 413 });
    }
  });

  it("ZIP이 아닌 DOCX는 읽기 오류", async () => {
    await expect(extractText({ name: "cv.docx", type: "", bytes: enc.encode(LONG) })).rejects.toBeInstanceOf(IngestError);
  });

  it(`${MAX_PDF_PAGES}쪽을 넘는 PDF는 413`, async () => {
    const line = "Jane Doe - Backend Engineer. Built payment systems in Kotlin and Spring Boot for 3 years.";
    await expect(
      extractText({ name: "cv.pdf", type: "application/pdf", bytes: tinyPdf(line, MAX_PDF_PAGES + 1) }),
    ).rejects.toMatchObject({ status: 413 });
    const ok = await extractText({ name: "cv.pdf", type: "application/pdf", bytes: tinyPdf(line, 3) });
    expect(ok.text.match(/Backend Engineer/g)).toHaveLength(3);
  });

  it("maxChars를 넘으면 남은 쪽을 읽지 않는다", async () => {
    const line = "Jane Doe - Backend Engineer. Built payment systems in Kotlin and Spring Boot for 3 years.";
    const r = await extractText({ name: "cv.pdf", type: "application/pdf", bytes: tinyPdf(line, 10) }, { maxChars: 100 });
    expect(r.text.match(/Backend Engineer/g)).toHaveLength(2);
  });
});
