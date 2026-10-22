/**
 * 업로드 파일(이력서·JD)에서 텍스트를 뽑는다. PDF(unpdf), DOCX(mammoth), TXT/MD(UTF-8)만 받는다.
 * 실패는 사용자에게 그대로 보여줄 한국어 메시지를 담은 IngestError로 던진다.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_TEXT_LENGTH = 50;

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

export async function extractText(file: {
  name: string;
  type: string;
  bytes: Uint8Array;
}): Promise<{ text: string; warnings: string[] }> {
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
        ? await extractPdf(file.bytes)
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

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
  const cMapUrl = pdfjsCMapDir();
  // pdf.js가 버퍼를 워커로 넘기며 분리(detach)할 수 있으므로 복사본을 넘긴다.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), cMapUrl ? { cMapUrl, cMapPacked: true } : {});
  try {
    const { text } = await pdfText(pdf, { mergePages: true });
    return text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

async function extractDocx(bytes: Uint8Array, warnings: string[]): Promise<string> {
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
