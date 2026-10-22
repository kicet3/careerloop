/**
 * 업로드 파일(이력서·JD)에서 텍스트를 뽑는다. PDF(unpdf), DOCX(mammoth), TXT/MD(UTF-8)만 받는다.
 * 실패는 사용자에게 그대로 보여줄 한국어 메시지를 담은 IngestError로 던진다.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_TEXT_LENGTH = 50;

/** PDF 페이지 상한. 이력서·공고가 이보다 길 일은 없고, 수천 쪽 PDF로 이벤트 루프를 붙잡는 것을 막는다. */
export const MAX_PDF_PAGES = 50;
/** PDF 텍스트 추출에 쓸 수 있는 시간(페이지 사이에서 검사). */
export const PDF_TIME_BUDGET_MS = 15_000;
/** 추출 텍스트 상한(기본). 넘으면 더 읽지 않는다 — 어차피 폼 검증에서 길이 초과로 거절된다. */
export const DEFAULT_MAX_CHARS = 100_000;
/** DOCX(ZIP) 안 파일 하나의 압축 해제 크기 상한과 전체 합계 상한(zip bomb 방지). */
export const MAX_DOCX_ENTRY_BYTES = 20 * 1024 * 1024;
export const MAX_DOCX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 2000;

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

type FileKind = "pdf" | "docx" | "text";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function detectKind(name: string, type: string): FileKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "md" || ext === "markdown") return "text";
  // 확장자가 없을 때만 MIME으로 판단한다(.hwp·.doc 등은 거절).
  if (ext) return null;
  const mime = type.toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return "pdf";
  if (mime === DOCX_MIME) return "docx";
  if (mime === "text/plain" || mime === "text/markdown" || mime === "text/x-markdown") return "text";
  return null;
}

/** NFC 정규화, 줄바꿈 통일, 줄 끝 공백 제거, 빈 줄 3개 이상 → 2개, 앞뒤 공백 제거. */
export function normalizeText(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractText(
  file: {
    name: string;
    type: string;
    bytes: Uint8Array;
  },
  opts: { maxChars?: number } = {},
): Promise<{ text: string; warnings: string[] }> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new IngestError("파일이 너무 큽니다. 10MB 이하 파일만 올릴 수 있습니다.", 413);
  }
  if (file.bytes.byteLength === 0) {
    throw new IngestError("빈 파일입니다. 다른 파일을 올리거나 텍스트를 붙여넣어 주세요.");
  }
  const kind = detectKind(file.name, file.type);
  if (!kind) {
    throw new IngestError(
      "지원하지 않는 파일 형식입니다. PDF, DOCX, TXT, MD 파일만 올릴 수 있습니다. (HWP·DOC는 PDF로 변환하거나 텍스트를 붙여넣어 주세요.)",
      415,
    );
  }

  const warnings: string[] = [];
  let raw: string;
  try {
    raw =
      kind === "pdf"
        ? await extractPdf(file.bytes, maxChars)
        : kind === "docx"
          ? await extractDocx(file.bytes, warnings)
          : decodeUtf8(file.bytes, warnings);
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(
      kind === "pdf"
        ? "PDF를 읽지 못했습니다. 암호가 걸려 있거나 손상된 파일일 수 있습니다. 텍스트를 붙여넣어 주세요."
        : kind === "docx"
          ? "DOCX를 읽지 못했습니다. 손상된 파일이거나 DOCX 형식이 아닐 수 있습니다. 텍스트를 붙여넣어 주세요."
          : "파일을 읽지 못했습니다. 텍스트를 붙여넣어 주세요.",
    );
  }

  const text = normalizeText(raw);
  if (text.length < MIN_TEXT_LENGTH) {
    throw new IngestError(
      kind === "pdf"
        ? "PDF에서 텍스트를 거의 찾지 못했습니다. 스캔본·이미지 PDF로 보입니다 — 내용을 복사해 텍스트로 붙여넣어 주세요."
        : "파일에서 읽을 수 있는 텍스트가 너무 적습니다. 내용을 텍스트로 붙여넣어 주세요.",
    );
  }
  return { text, warnings };
}

/**
 * pdfjs-dist의 CMap 폴더(파일 시스템 경로, 끝에 `/`). 한국어 PDF는 ToUnicode 없이 Adobe-Korea1 CID 글꼴을 쓰는 경우가
 * 많아(macOS '미리보기'·Pages로 저장한 PDF 등) CMap이 없으면 한글이 통째로 빠진다. unpdf 기본값은 `file://` URL이라
 * Node의 pdf.js가 읽지 못하므로 일반 경로로 넘긴다.
 */
function pdfjsCMapDir(): string | undefined {
  const dir = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "pdfjs-dist", "cmaps") + path.sep;
  return existsSync(dir) ? dir : undefined;
}

/**
 * PDF 텍스트를 페이지 단위로 뽑는다(unpdf의 mergePages와 같은 결합 규칙). 페이지 수 상한을 넘으면 거절하고,
 * 시간 예산을 넘으면 거절하며, maxChars를 넘으면 거기서 멈춘다(넘친 결과는 폼 검증이 길이 초과로 거절한다).
 */
async function extractPdf(bytes: Uint8Array, maxChars: number): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const cMapUrl = pdfjsCMapDir();
  // pdf.js가 버퍼를 워커로 넘기며 분리(detach)할 수 있으므로 복사본을 넘긴다.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), cMapUrl ? { cMapUrl, cMapPacked: true } : {});
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new IngestError(
        `PDF가 ${pdf.numPages}쪽입니다. ${MAX_PDF_PAGES}쪽 이하 파일만 읽습니다. 이력서·공고 부분만 저장하거나 텍스트를 붙여넣어 주세요.`,
        413,
      );
    }
    const started = Date.now();
    const texts: string[] = [];
    let chars = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      if (Date.now() - started > PDF_TIME_BUDGET_MS) {
        throw new IngestError("PDF를 읽는 데 너무 오래 걸립니다. 텍스트를 붙여넣어 주세요.", 413);
      }
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item && item.str != null ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      page.cleanup();
      texts.push(text);
      chars += text.length;
      if (chars > maxChars) break;
    }
    // unpdf extractText(mergePages)와 같은 정규화
    return texts.join("\n").replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n");
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/**
 * DOCX(ZIP)의 압축 해제 크기를 mammoth에 넘기기 전에 확인한다. 중앙 디렉터리의 선언 크기는 거짓일 수 있으므로
 * 각 항목을 maxOutputLength를 건 inflate로 실제로 풀어 본다(상한을 넘는 순간 zlib이 멈춘다).
 * 상한을 넘거나 구조가 이상하면 IngestError.
 */
export function assertDocxWithinLimits(bytes: Uint8Array): void {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tooBig = () =>
    new IngestError("DOCX 압축을 풀면 너무 커집니다. 다른 파일을 올리거나 텍스트를 붙여넣어 주세요.", 413);
  const broken = () => new IngestError("DOCX 구조를 읽지 못했습니다. 손상된 파일일 수 있습니다. 텍스트를 붙여넣어 주세요.");

  // End of central directory 레코드: 파일 끝에서 22 + 최대 65535(주석)바이트 안에 있다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw broken();
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw tooBig(); // ZIP64는 받지 않는다
  if (entries > MAX_DOCX_ENTRIES) throw tooBig();
  if (cdOffset + cdSize > buf.length) throw broken();

  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw broken();
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const declared = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || declared === 0xffffffff || localOffset === 0xffffffff) throw tooBig();
    if (declared > MAX_DOCX_ENTRY_BYTES) throw tooBig();
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw broken();
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buf.length) throw broken();

    const limit = Math.min(MAX_DOCX_ENTRY_BYTES, MAX_DOCX_TOTAL_BYTES - total);
    let actual: number;
    if (method === 0) {
      actual = compSize;
    } else if (method === 8) {
      try {
        // limit+1바이트까지만 풀도록 해서, 그만큼 나오면 상한 초과로 본다.
        actual = inflateRawSync(buf.subarray(dataStart, dataStart + compSize), { maxOutputLength: limit + 1 }).byteLength;
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
        throw broken();
      }
    } else {
      throw broken();
    }
    if (actual > limit) throw tooBig();
    total += actual;
  }
}

async function extractDocx(bytes: Uint8Array, warnings: string[]): Promise<string> {
  assertDocxWithinLimits(bytes);
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  if (result.messages.some((m) => m.type === "error")) {
    warnings.push("DOCX 일부를 읽지 못했을 수 있습니다. 결과 텍스트를 확인해 주세요.");
  }
  return result.value;
}

function decodeUtf8(bytes: Uint8Array, warnings: string[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    warnings.push("UTF-8이 아닌 문자가 있어 일부 글자가 깨졌을 수 있습니다. UTF-8로 저장하거나 붙여넣어 주세요.");
    return new TextDecoder("utf-8").decode(bytes);
  }
}
