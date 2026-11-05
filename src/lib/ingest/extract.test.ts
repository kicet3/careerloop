import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import * as CFB from "cfb";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_HWP_BODY_BYTES, readHwpSection } from "./hwp";
import {
  assertDocxWithinLimits,
  detectKind,
  extractText,
  IngestError,
  MAX_DOCX_ENTRY_BYTES,
  MAX_HWPX_TOTAL_BYTES,
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
    expect(detectKind("cv.hwp", "application/pdf")).toBe("hwp");
    expect(detectKind("이력서.HWPX", "")).toBe("hwpx");
    expect(detectKind("경력.htm", "")).toBe("html");
    expect(detectKind("cv", "application/x-hwp")).toBe("hwp");
    expect(detectKind("cv", "text/html; charset=euc-kr")).toBe("html");
    expect(detectKind("cv.doc", "")).toBeNull();
    expect(detectKind("cv.hwt", "application/x-hwp")).toBeNull();
  });
});

describe("extractText", () => {
  it("TXT를 UTF-8로 읽고 정규화한다", async () => {
    const r = await extractText({ name: "resume.txt", type: "text/plain", bytes: enc.encode(`${LONG}\n\n\n\n끝`) });
    expect(r.text).toBe(`${LONG}\n\n끝`);
    expect(r.warnings).toEqual([]);
  });

  it("지원하지 않는 형식은 415 IngestError", async () => {
    const p = extractText({ name: "resume.doc", type: "application/msword", bytes: enc.encode(LONG) });
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

// ---------------------------------------------------------------------------
// HWP·HWPX·HTML — CareerLoop(src/server/extract.test.ts)에서 가져와 늘림
// ---------------------------------------------------------------------------

const HWP_BODY = "프로젝트 경험\r본인 역할: 결제 API를 Kotlin과 Spring Boot로 설계하고 장애율을 40% 줄였습니다.";
const HWP_TEXT = "프로젝트 경험\n본인 역할: 결제 API를 Kotlin과 Spring Boot로 설계하고 장애율을 40% 줄였습니다.";

/** HWP 5.x 최소 문서(CFB). 첫 문단 앞에 확장 제어 문자(구역 정의 'secd') 하나를 넣는다. */
function hwpFixture(opts: { compressed?: boolean; flags?: number; truncate?: boolean; version?: number; sections?: Buffer[] } = {}) {
  const { compressed = true, flags = 0, truncate = false, version = 5 } = opts;
  const cfb = CFB.utils.cfb_new();
  const fileHeader = Buffer.alloc(256);
  fileHeader.write("HWP Document File");
  fileHeader[35] = version;
  fileHeader.writeUInt32LE((compressed ? 1 : 0) | flags, 36);
  CFB.utils.cfb_add(cfb, "FileHeader", fileHeader);
  const sections = opts.sections ?? [paraRecord(HWP_BODY, true)];
  sections.forEach((record, i) => {
    const body = truncate ? record.subarray(0, 11) : record;
    CFB.utils.cfb_add(cfb, `BodyText/Section${i}`, compressed ? deflateRawSync(body) : body);
  });
  return new Uint8Array(CFB.write(cfb, { type: "buffer" }) as Buffer);
}

/** PARA_TEXT(67) 레코드 하나. withControl이면 앞에 8 WCHAR 확장 제어를 붙인다. */
function paraRecord(text: string, withControl = false): Buffer {
  const control = Buffer.alloc(16);
  control.writeUInt16LE(2);
  control.write("dces", 2, "ascii");
  control.writeUInt16LE(2, 14);
  const content = Buffer.concat([withControl ? control : Buffer.alloc(0), Buffer.from(text, "utf16le")]);
  const header = Buffer.alloc(4);
  header.writeUInt32LE((content.length << 20) | 67);
  return Buffer.concat([header, content]);
}

describe("HWP 5.x", () => {
  it.each([true, false])("본문에서 제어 문자를 빼고 한국어를 읽는다 (압축 %s)", async (compressed) => {
    const r = await extractText({ name: "resume.hwp", type: "", bytes: hwpFixture({ compressed }) });
    expect(r.text).toBe(HWP_TEXT);
  });

  it("여러 구역을 번호 순서(10이 2 뒤)로 읽는다", async () => {
    const sections = Array.from({ length: 11 }, (_, i) => paraRecord(`구역 ${i} — 경력 기술서 내용을 충분히 길게 적습니다.`));
    const r = await extractText({ name: "cv.hwp", type: "", bytes: hwpFixture({ sections }) });
    const order = [...r.text.matchAll(/구역 (\d+)/g)].map((m) => Number(m[1]));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it.each([
    [2, /암호/],
    [256, /암호/],
    [4, /배포용/],
    [16, /DRM/],
    [1024, /DRM/],
  ])("읽을 수 없는 HWP(속성 %i)는 한국어 안내와 함께 415", async (flag, message) => {
    const p = extractText({ name: "resume.hwp", type: "", bytes: hwpFixture({ flags: flag }) });
    await expect(p).rejects.toThrow(message);
    await expect(p).rejects.toMatchObject({ status: 415 });
  });

  it("HWP 3.x와 HWP가 아닌 파일은 이유를 밝혀 거절한다", async () => {
    const v3 = Buffer.alloc(128);
    v3.write("HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05");
    await expect(extractText({ name: "old.hwp", type: "", bytes: new Uint8Array(v3) })).rejects.toThrow(/HWP 3\.x/);
    await expect(extractText({ name: "fake.hwp", type: "", bytes: enc.encode(LONG) })).rejects.toThrow(/HWP 파일이 아닙니다/);
    await expect(extractText({ name: "v4.hwp", type: "", bytes: hwpFixture({ version: 4 }) })).rejects.toThrow(/HWP 5\.x/);
  });

  it("레코드가 잘린 HWP는 손상 안내", async () => {
    await expect(extractText({ name: "cv.hwp", type: "", bytes: hwpFixture({ truncate: true }) })).rejects.toThrow(/손상/);
  });

  it(`압축을 풀면 ${MAX_HWP_BODY_BYTES / 1024 / 1024}MB를 넘는 HWP는 413`, async () => {
    // 압축률이 매우 높은 큰 레코드(공백만). 선언 크기와 상관없이 실제로 풀어 보다가 멈춘다.
    const huge = Buffer.alloc(MAX_HWP_BODY_BYTES + 1024, 0x20);
    const bytes = hwpFixture({ sections: [huge] });
    expect(bytes.byteLength).toBeLessThan(MAX_UPLOAD_BYTES);
    await expect(extractText({ name: "bomb.hwp", type: "", bytes })).rejects.toMatchObject({ status: 413 });
  });

  it("readHwpSection: 탭은 공백, 묶음 빈칸은 공백으로", () => {
    const tab = Buffer.alloc(16);
    tab.writeUInt16LE(9);
    const content = Buffer.concat([Buffer.from("가", "utf16le"), tab, Buffer.from("나\u001e다", "utf16le")]);
    const header = Buffer.alloc(4);
    header.writeUInt32LE((content.length << 20) | 67);
    expect(readHwpSection(Buffer.concat([header, content]))).toBe("가 나 다");
  });
});

describe("HWPX", () => {
  const section = (text: string) =>
    strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hs:sec>`,
    );
  const pad = " — 결제 시스템 운영 경력과 성과를 자세히 적은 문단입니다.";

  it("구역을 숫자 순서로 읽고 header.xml 등 서식 파일은 뺀다", async () => {
    const archive = zipSync({
      mimetype: strToU8("application/hwp+zip"),
      "Contents/section10.xml": section("마지막" + pad),
      "Contents/section2.xml": section("중간" + pad),
      "Contents/section0.xml": section("처음 &amp; 역할" + pad),
      "Contents/header.xml": strToU8("<hh:head>제외할 서식</hh:head>"),
    });
    const r = await extractText({ name: "resume.hwpx", type: "", bytes: archive });
    expect(r.text).toBe(`처음 & 역할${pad}\n\n중간${pad}\n\n마지막${pad}`);
  });

  it("글자 요소 안의 탭·줄바꿈을 살린다", async () => {
    const xml = `<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>기간<hp:tab/>2021-2024<hp:lineBreak/>회사: 페이랩${pad}</hp:t></hp:run></hp:p></hs:sec>`;
    const r = await extractText({ name: "cv.hwpx", type: "", bytes: zipSync({ "Contents/section0.xml": strToU8(xml) }) });
    expect(r.text).toBe(`기간 2021-2024\n회사: 페이랩${pad}`);
  });

  it("암호가 걸린 HWPX(manifest의 encryption-data)는 415", async () => {
    const archive = zipSync({
      "META-INF/manifest.xml": strToU8('<odf:manifest><odf:file-entry odf:full-path="Contents/section0.xml"><odf:encryption-data/></odf:file-entry></odf:manifest>'),
      "Contents/section0.xml": new Uint8Array([1, 2, 3, 4]),
    });
    await expect(extractText({ name: "locked.hwpx", type: "", bytes: archive })).rejects.toMatchObject({ status: 415 });
  });

  it("본문 구역이 없으면 안내, ZIP이 아니면 손상 안내", async () => {
    await expect(
      extractText({ name: "cv.hwpx", type: "", bytes: zipSync({ "Contents/header.xml": strToU8("<x/>") }) }),
    ).rejects.toThrow(/본문/);
    await expect(extractText({ name: "cv.hwpx", type: "", bytes: enc.encode(LONG) })).rejects.toThrow(/HWPX 구조/);
  });

  it(`압축을 풀면 ${MAX_HWPX_TOTAL_BYTES / 1024 / 1024}MB를 넘는 HWPX(zip bomb)는 413 — 선언 크기가 거짓이어도`, async () => {
    const bomb = Buffer.alloc(MAX_HWPX_TOTAL_BYTES + 1024, 0x20);
    for (const declaredSize of [undefined, 1000]) {
      const bytes = makeZip([{ name: "Contents/section0.xml", data: bomb, declaredSize }]);
      await expect(extractText({ name: "bomb.hwpx", type: "", bytes })).rejects.toMatchObject({ status: 413 });
    }
  });
});

describe("HTML", () => {
  it("본문과 엔티티를 읽고 스크립트·스타일·숨긴 내용을 뺀다", async () => {
    const html =
      '<html><head><title>제목</title><script>비밀()</script></head><body><h1>경험 &amp; 성과</h1>' +
      "<p>결제 요청 실패율을 <b>50%</b> 줄이고 정산 배치를 2시간에서 10분으로 단축했습니다.</p>" +
      '<div hidden>숨긴 내용</div><span style="display: none">안 보임</span><style>body {color:red}</style>' +
      "<noscript>노스크립트</noscript><p>본인 역할</p></body></html>";
    const r = await extractText({ name: "resume.html", type: "", bytes: enc.encode(html) });
    expect(r.text).toBe(
      "경험 & 성과\n\n결제 요청 실패율을 50% 줄이고 정산 배치를 2시간에서 10분으로 단축했습니다.\n\n본인 역할",
    );
  });

  it("소스의 들여쓰기·줄바꿈은 공백 하나로 접고, br·표는 구분한다", async () => {
    const html = `<body>
      <p>
        Kotlin   Spring Boot
        PostgreSQL 운영 경험 3년
      </p>
      <table><tr><td>기간</td><td>2021-2024</td></tr><tr><td>회사</td><td>페이랩</td></tr></table>
      <p>첫 줄<br>둘째 줄</p>
    </body>`;
    const r = await extractText({ name: "cv.htm", type: "", bytes: enc.encode(html) });
    expect(r.text).toBe("Kotlin Spring Boot PostgreSQL 운영 경험 3년\n\n기간 2021-2024\n회사 페이랩\n\n첫 줄\n둘째 줄");
  });

  it("meta charset이 EUC-KR이면 그 인코딩으로 읽는다", async () => {
    // "한글 이력서" (EUC-KR)
    const korean = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xc0, 0xcc, 0xb7, 0xc2, 0xbc, 0xad]);
    const bytes = Buffer.concat([
      Buffer.from('<html><head><meta charset="euc-kr"></head><body><p>'),
      korean,
      Buffer.from(" - Backend Engineer, payment systems in Kotlin and Spring Boot</p></body></html>"),
    ]);
    const r = await extractText({ name: "cv.html", type: "", bytes: new Uint8Array(bytes) });
    expect(r.text.startsWith("한글 이력서 - Backend")).toBe(true);
  });
});
