/**
 * 업로드 파일(이력서·포트폴리오·JD)에서 텍스트를 뽑는다. PDF(unpdf), DOCX(mammoth), HWP 5.x(cfb), HWPX(ZIP+XML),
 * HTML(htmlparser2, 스크립트 무시), TXT/MD(UTF-8)를 받는다.
 * 실패는 사용자에게 그대로 보여줄 한국어 메시지를 담은 IngestError로 던진다.
 * HWP·HWPX·HTML 경로는 CareerLoop(src/server/extract.ts)에서 가져와 고쳤다(hwp.ts·markup.ts·zip.ts).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { IngestError } from "./errors";
import { extractHwp } from "./hwp";
import { decodeHtml, htmlText, hwpxSectionText } from "./markup";
import { formatMb, SELF_HOSTED_UPLOAD_LIMITS, uploadLimitsFor } from "./upload-limits";
import { readZipWithinLimits, ZipLimitError } from "./zip";
import { isSpaceTabNbsp, trimLineEnds } from "@/lib/text/whitespace";

export { IngestError } from "./errors";

/** 자체 호스팅의 파일당 상한. 실제 상한은 uploadLimitsFor()(Vercel은 4MB). */
export const MAX_UPLOAD_BYTES = SELF_HOSTED_UPLOAD_LIMITS.perFileBytes;
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
/** HWPX(ZIP) 압축 해제 합계 상한. HWP 본문 상한(MAX_HWP_BODY_BYTES)과 같다. */
export const MAX_HWPX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_HWPX_ENTRIES = 2000;

export type FileKind = "pdf" | "docx" | "hwp" | "hwpx" | "html" | "text";

/** 업로드 UI가 받는 확장자(서버 detectKind와 같은 목록). */
export const UPLOAD_EXTENSIONS = [".pdf", ".docx", ".hwp", ".hwpx", ".html", ".htm", ".txt", ".md"] as const;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const HWP_MIMES = new Set(["application/x-hwp", "application/haansofthwp", "application/vnd.hancom.hwp"]);
const HWPX_MIMES = new Set(["application/hwp+zip", "application/vnd.hancom.hwpx", "application/haansofthwpx"]);

export function detectKind(name: string, type: string): FileKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "hwp") return "hwp";
  if (ext === "hwpx") return "hwpx";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "txt" || ext === "md" || ext === "markdown") return "text";
  // 확장자가 없을 때만 MIME으로 판단한다(.doc 등 모르는 확장자는 거절).
  if (ext) return null;
  const mime = type.toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return "pdf";
  if (mime === DOCX_MIME) return "docx";
  if (HWP_MIMES.has(mime)) return "hwp";
  if (HWPX_MIMES.has(mime)) return "hwpx";
  if (mime === "text/html") return "html";
  if (mime === "text/plain" || mime === "text/markdown" || mime === "text/x-markdown") return "text";
  return null;
}

/** NFC 정규화, 줄바꿈 통일, 줄 끝 공백 제거, 빈 줄 3개 이상 → 2개, 앞뒤 공백 제거. */
export function normalizeText(raw: string): string {
  const text = raw
    .replace(/^\uFEFF/, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
  // 줄 끝 공백은 줄 단위로 지운다. `/[ \t\u00a0]+$/gm`은 긴 공백 덩어리 뒤에 글자가 오면 O(n²)이다(ReDoS).
  return trimLineEnds(text, isSpaceTabNbsp)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 형식별 읽기 실패 기본 안내(IngestError가 아닌 예외일 때). */
const READ_FAILURE: Record<FileKind, string> = {
  pdf: "PDF를 읽지 못했습니다. 암호가 걸려 있거나 손상된 파일일 수 있습니다. 텍스트를 붙여넣어 주세요.",
  docx: "DOCX를 읽지 못했습니다. 손상된 파일이거나 DOCX 형식이 아닐 수 있습니다. 텍스트를 붙여넣어 주세요.",
  hwp: "HWP를 읽지 못했습니다. 손상된 파일일 수 있습니다. 한글에서 PDF로 내보내거나 텍스트를 붙여넣어 주세요.",
  hwpx: "HWPX를 읽지 못했습니다. 손상된 파일일 수 있습니다. 한글에서 PDF로 내보내거나 텍스트를 붙여넣어 주세요.",
  html: "HTML 파일을 읽지 못했습니다. 텍스트를 붙여넣어 주세요.",
  text: "파일을 읽지 못했습니다. 텍스트를 붙여넣어 주세요.",
};

export async function extractText(
  file: {
    name: string;
    type: string;
    bytes: Uint8Array;
  },
  opts: { maxChars?: number; maxBytes?: number } = {},
): Promise<{ text: string; warnings: string[] }> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBytes = opts.maxBytes ?? uploadLimitsFor().perFileBytes;
  if (file.bytes.byteLength > maxBytes) {
    throw new IngestError(`파일이 너무 큽니다. ${formatMb(maxBytes)} 이하 파일만 올릴 수 있습니다.`, 413);
  }
  if (file.bytes.byteLength === 0) {
    throw new IngestError("빈 파일입니다. 다른 파일을 올리거나 텍스트를 붙여넣어 주세요.");
  }
  const kind = detectKind(file.name, file.type);
  if (!kind) {
    throw new IngestError(
      "지원하지 않는 파일 형식입니다. PDF, DOCX, HWP, HWPX, HTML, TXT, MD 파일만 올릴 수 있습니다. (DOC 등은 PDF로 변환하거나 텍스트를 붙여넣어 주세요.)",
      415,
    );
  }

  const warnings: string[] = [];
  let raw: string;
  try {
    switch (kind) {
      case "pdf":
        raw = await extractPdf(file.bytes, maxChars);
        break;
      case "docx":
        raw = await extractDocx(file.bytes, warnings);
        break;
      case "hwp":
        raw = extractHwp(file.bytes, maxChars);
        break;
      case "hwpx":
        raw = extractHwpx(file.bytes, maxChars);
        break;
      case "html":
        raw = htmlText(decodeHtml(file.bytes), maxChars);
        break;
      case "text":
        raw = decodeUtf8(file.bytes, warnings);
        break;
    }
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(READ_FAILURE[kind]);
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
 * DOCX(ZIP)의 압축 해제 크기를 mammoth에 넘기기 전에 확인한다. 선언 크기가 아니라 실제로 풀어 본 크기로 판단한다(zip.ts).
 * 상한을 넘거나 구조가 이상하면 IngestError.
 */
export function assertDocxWithinLimits(bytes: Uint8Array): void {
  try {
    readZipWithinLimits(bytes, {
      maxEntryBytes: MAX_DOCX_ENTRY_BYTES,
      maxTotalBytes: MAX_DOCX_TOTAL_BYTES,
      maxEntries: MAX_DOCX_ENTRIES,
    });
  } catch (err) {
    throw zipError(err, "DOCX");
  }
}

function zipError(err: unknown, label: "DOCX" | "HWPX"): unknown {
  if (!(err instanceof ZipLimitError)) return err;
  if (err.reason === "too-big") {
    return new IngestError(`${label} 압축을 풀면 너무 커집니다. 다른 파일을 올리거나 텍스트를 붙여넣어 주세요.`, 413);
  }
  if (err.reason === "encrypted") {
    return new IngestError(`암호가 걸린 ${label}는 읽을 수 없습니다. 암호를 해제하거나 PDF로 내보내 올려 주세요.`, 415);
  }
  return new IngestError(`${label} 구조를 읽지 못했습니다. 손상된 파일일 수 있습니다. 텍스트를 붙여넣어 주세요.`);
}

const HWPX_SECTION = /^Contents\/section(\d+)\.xml$/i;

/**
 * HWPX(한글 2010 이후 개방형, ZIP 안의 XML): Contents/sectionN.xml을 번호 순서로 읽는다.
 * 암호를 건 HWPX는 META-INF/manifest.xml에 encryption-data가 있고 구역 XML이 암호문이라 거절한다.
 */
function extractHwpx(bytes: Uint8Array, maxChars: number): string {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipWithinLimits(
      bytes,
      { maxEntryBytes: MAX_HWPX_TOTAL_BYTES, maxTotalBytes: MAX_HWPX_TOTAL_BYTES, maxEntries: MAX_HWPX_ENTRIES },
      (name) => HWPX_SECTION.test(name) || name === "META-INF/manifest.xml",
    );
  } catch (err) {
    throw zipError(err, "HWPX");
  }
  if (entries.get("META-INF/manifest.xml")?.toString("utf8").includes("encryption-data")) {
    throw new IngestError("암호가 걸린 HWPX는 읽을 수 없습니다. 한글에서 암호를 해제하거나 PDF로 내보내 올려 주세요.", 415);
  }
  const sections = [...entries.keys()]
    .filter((name) => HWPX_SECTION.test(name))
    .sort((a, b) => Number(HWPX_SECTION.exec(a)![1]) - Number(HWPX_SECTION.exec(b)![1]));
  if (!sections.length) {
    throw new IngestError("HWPX 본문(Contents/section*.xml)을 찾지 못했습니다. 한글에서 PDF로 내보내 올려 주세요.");
  }
  // HWP 경로처럼 maxChars에 닿으면 더 읽지 않는다(작은 zip이 32MB 텍스트로 불어나는 것을 막는다).
  const texts: string[] = [];
  let chars = 0;
  for (const name of sections) {
    if (chars > maxChars) break;
    const text = hwpxSectionText(entries.get(name)!.toString("utf8"), maxChars - chars);
    texts.push(text);
    chars += text.length + 2;
  }
  return texts.join("\n\n");
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
