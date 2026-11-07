import "server-only";
/**
 * 포트폴리오 원본 파일: 형식 판별(확장자 + 매직 바이트), 크기 상한, 텍스트 추출(AI용), 내려줄 때의 헤더.
 *
 * - 형식은 확장자로 고르고 내용의 앞부분(매직 바이트)이 그 형식과 맞아야 받는다. MIME은 브라우저가 보낸 값이 아니라 서버가 정한다.
 * - 원본은 그대로 보관한다(users/<u>/portfolios/<id>/original-<꼬리>.<확장자>). AI에는 뽑은 글만 넘긴다 — 이미지는 글을 뽑지 않고,
 *   글을 뽑지 못한 파일(스캔 PDF·쪽 수 초과 등)도 원본은 보관하고 경고만 돌려준다(설명을 적으면 AI가 그걸 읽는다).
 * - 내려줄 때(GET /api/portfolios/[id]/original): HTML처럼 우리 출처에서 실행될 수 있는 형식은 늘 첨부(attachment) +
 *   application/octet-stream + CSP sandbox로 보내 브라우저가 열지 않게 한다. PDF·이미지·글만 inline.
 */
import { assertDocxWithinLimits, extractText, IngestError } from "@/lib/ingest/extract";
import { formatMb, VERCEL_UPLOAD_LIMITS } from "@/lib/ingest/upload-limits";
import { DEFAULT_PORTFOLIO_MAX_UPLOAD_MB, MAX_PORTFOLIO_TEXT_CHARS } from "@/lib/domain/portfolios";

const MB = 1024 * 1024;

export type PortfolioFileKind = "pdf" | "docx" | "hwp" | "hwpx" | "html" | "txt" | "md" | "png" | "jpg" | "webp";

interface KindSpec {
  /** 저장 키에 쓰는 확장자 */
  ext: PortfolioFileKind;
  mime: string;
  image: boolean;
  /** 내용 앞부분 검사 */
  magic: (b: Uint8Array) => boolean;
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** 글 파일: 앞 8KB에 NUL이 없어야 한다(실행 파일·이미지를 .txt로 바꿔 올린 것 거르기). UTF-16 BOM은 받지 않는다(추출이 UTF-8만 읽는다). */
const looksText = (b: Uint8Array) => !b.subarray(0, 8192).includes(0);

/** PDF: 앞 1024바이트 안에 %PDF- (명세상 앞에 다른 바이트가 올 수 있다). */
function isPdf(b: Uint8Array): boolean {
  const head = Buffer.from(b.subarray(0, 1024)).toString("latin1");
  return head.includes("%PDF-");
}

const SPECS: Record<PortfolioFileKind, KindSpec> = {
  pdf: { ext: "pdf", mime: "application/pdf", image: false, magic: isPdf },
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", image: false, magic: (b) => startsWith(b, ZIP) },
  hwp: { ext: "hwp", mime: "application/x-hwp", image: false, magic: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  hwpx: { ext: "hwpx", mime: "application/hwp+zip", image: false, magic: (b) => startsWith(b, ZIP) },
  html: { ext: "html", mime: "text/html", image: false, magic: looksText },
  txt: { ext: "txt", mime: "text/plain", image: false, magic: looksText },
  md: { ext: "md", mime: "text/markdown", image: false, magic: looksText },
  png: { ext: "png", mime: "image/png", image: true, magic: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { ext: "jpg", mime: "image/jpeg", image: true, magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  webp: { ext: "webp", mime: "image/webp", image: true, magic: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) },
};

const EXT_ALIASES: Record<string, PortfolioFileKind> = {
  pdf: "pdf",
  docx: "docx",
  hwp: "hwp",
  hwpx: "hwpx",
  html: "html",
  htm: "html",
  txt: "txt",
  md: "md",
  markdown: "md",
  png: "png",
  jpg: "jpg",
  jpeg: "jpg",
  webp: "webp",
};

export const UNSUPPORTED_PORTFOLIO_FILE =
  "지원하지 않는 파일 형식입니다. PDF, DOCX, HWP, HWPX, HTML, TXT, MD, PNG, JPG, WEBP 파일만 올릴 수 있습니다. (DOC 등은 PDF로 변환해 올려 주세요.)";

/** 파일 이름의 확장자로 형식을 고른다(모르는 확장자는 null). */
export function portfolioKindFromName(name: string): PortfolioFileKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return EXT_ALIASES[ext] ?? null;
}

export function portfolioKindSpec(kind: PortfolioFileKind): Readonly<KindSpec> {
  return SPECS[kind];
}

/** 확장자 + 매직 바이트 확인. 맞지 않으면 IngestError(415). */
export function detectPortfolioFile(name: string, bytes: Uint8Array): Readonly<KindSpec> {
  const kind = portfolioKindFromName(name);
  if (!kind) throw new IngestError(UNSUPPORTED_PORTFOLIO_FILE, 415);
  const spec = SPECS[kind];
  if (!spec.magic(bytes)) {
    throw new IngestError(`파일 내용이 ${kind.toUpperCase()} 형식이 아닙니다. 확장자가 실제 형식과 맞는지 확인해 주세요.`, 415);
  }
  return spec;
}

/** 포트폴리오 파일 하나의 상한(바이트). PORTFOLIO_MAX_UPLOAD_MB(1~100, 기본 30). */
export function portfolioMaxFileBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.PORTFOLIO_MAX_UPLOAD_MB?.trim());
  const mb = Number.isFinite(raw) && raw >= 1 ? Math.min(100, Math.floor(raw)) : DEFAULT_PORTFOLIO_MAX_UPLOAD_MB;
  return mb * MB;
}

/**
 * 서버로 바로(multipart) 받는 상한. Vercel은 요청 본문 4.5MB에 묶여 4MB, 자체 호스팅은 파일 상한(기본 30MB)까지 받는다.
 * 넘는 파일은 R2 서명 주소로 바로 올린다(presigned).
 */
export function portfolioDirectMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const cap = portfolioMaxFileBytes(env);
  return env.VERCEL?.trim() ? Math.min(cap, VERCEL_UPLOAD_LIMITS.perFileBytes) : cap;
}

export function tooLargeMessage(maxBytes: number): string {
  return `파일이 너무 큽니다. ${formatMb(maxBytes)} 이하 파일만 올릴 수 있습니다.`;
}

export interface IngestedPortfolioFile {
  spec: Readonly<KindSpec>;
  /** AI에 넘길 글. 뽑지 못했으면 "". */
  text: string;
  warnings: string[];
}

/**
 * 원본 확인 + 글 뽑기. 형식이 틀리면 IngestError(415), 크기를 넘으면 IngestError(413).
 * 글을 뽑지 못한 경우(이미지, 스캔 PDF, 쪽 수 초과, 손상 등)는 거절하지 않고 text ""와 경고를 돌려준다 — 원본은 그대로 보여 줄 수 있다.
 */
export async function ingestPortfolioFile(file: { name: string; bytes: Uint8Array }, maxBytes: number): Promise<IngestedPortfolioFile> {
  if (file.bytes.byteLength === 0) throw new IngestError("빈 파일입니다. 다른 파일을 올려 주세요.");
  if (file.bytes.byteLength > maxBytes) throw new IngestError(tooLargeMessage(maxBytes), 413);
  const spec = detectPortfolioFile(file.name, file.bytes);
  if (spec.image) {
    return {
      spec,
      text: "",
      warnings: ["이미지 파일은 원본 그대로 보여 주지만 AI(면접 질문·진단)는 그림 속 내용을 읽지 못합니다. 설명에 역할·결과를 적어 두면 반영됩니다."],
    };
  }
  try {
    const extracted = await extractText(
      // 추출기는 확장자로 형식을 고른다. .jpg 등은 위에서 걸렀다.
      { name: `portfolio.${spec.ext}`, type: spec.mime, bytes: file.bytes },
      { maxBytes, maxChars: MAX_PORTFOLIO_TEXT_CHARS + 1000 },
    );
    return { spec, text: extracted.text, warnings: [...extracted.warnings] };
  } catch (err) {
    if (!(err instanceof IngestError) || err.status === 415) throw err;
    return {
      spec,
      text: "",
      warnings: [
        `원본 파일은 그대로 보관했지만 글을 뽑지 못해 AI(면접 질문·진단)는 이 파일 내용을 읽지 못합니다. 설명에 역할·결과를 적어 주세요. (${err.message})`,
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// 내려주기
// ---------------------------------------------------------------------------

/** 우리 출처에서 inline으로 열어도 스크립트가 돌지 않는 형식. 나머지는 첨부로만 내려준다. */
const INLINE_MIMES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/markdown"]);

/** 보관한 MIME이 아는 값인지(DB 값을 그대로 헤더에 쓰지 않는다). */
const KNOWN_MIMES = new Set(Object.values(SPECS).map((s) => s.mime));

/** 스크립트·플러그인·폼·다른 출처 읽기를 모두 막는다. PDF는 브라우저 PDF 보기가 sandbox에서 열리지 않아 이것 대신 PDF_CSP를 쓴다. */
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'";
/** PDF: 브라우저 내장 PDF 보기(자체 격리)로만 열린다. 우리 화면 밖에서 iframe으로 끼워 넣지 못하게만 한다. */
const PDF_CSP = "frame-ancestors 'self'";

/** RFC 6266/5987: ASCII 대체 이름 + UTF-8 원래 이름. */
export function dispositionHeader(type: "inline" | "attachment", fileName: string, fallback: string): string {
  const safe = fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() || fallback;
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 서버를 거쳐 내려주는(본문을 함수 응답에 싣는) 원본 크기 상한. Vercel Functions는 스트리밍하지 않는 응답 본문도 4.5MB로 막으므로
 * 이보다 큰 원본은 R2 서명 GET 주소로 보낸다(로컬 저장소 = 자체 호스팅은 그대로 내려준다).
 */
export const ORIGINAL_PROXY_MAX_BYTES = 4 * MB;
/** 원본을 R2에서 바로 내려받는 서명 주소의 유효 시간(초). 소유자 확인을 마친 요청마다 새로 만든다. */
export const ORIGINAL_PRESIGN_TTL_SEC = 60;

/** 원본 응답의 내용 유형·Content-Disposition·CSP(우리 출처로 내려줄 때와 R2 서명 주소가 같은 판단을 쓴다). */
export function originalServeSpec(input: { mime: string; fileName: string; download: boolean; forceAttachmentForText?: boolean }): {
  contentType: string;
  disposition: string;
  csp: string;
} {
  const mime = KNOWN_MIMES.has(input.mime) ? input.mime : "application/octet-stream";
  const isText = mime === "text/plain" || mime === "text/markdown";
  const inline = !input.download && INLINE_MIMES.has(mime) && !(isText && input.forceAttachmentForText);
  const ext = Object.values(SPECS).find((s) => s.mime === mime)?.ext ?? "bin";
  const contentType = !INLINE_MIMES.has(mime)
    ? // 실행될 수 있는 형식(HTML)이나 브라우저가 열지 않는 형식은 내용 유형을 알리지 않는다(첨부).
      mime === "text/html"
      ? "application/octet-stream"
      : mime
    : isText
      ? "text/plain; charset=utf-8"
      : mime;
  return {
    contentType,
    disposition: dispositionHeader(inline ? "inline" : "attachment", input.fileName, `portfolio.${ext}`),
    csp: mime === "application/pdf" && inline ? PDF_CSP : SANDBOX_CSP,
  };
}

/**
 * 원본 응답 헤더. download면 늘 첨부. HTML·DOCX·HWP 등 inline이 아닌 형식은 application/octet-stream 첨부.
 */
export function originalResponseHeaders(input: { mime: string; size: number; fileName: string; download: boolean }): Headers {
  const spec = originalServeSpec(input);
  return new Headers({
    "Content-Type": spec.contentType,
    "Content-Length": String(input.size),
    "Content-Disposition": spec.disposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": spec.csp,
  });
}

/** DOCX 미리보기 HTML의 그림(data URI) 합계 상한. */
export const DOCX_HTML_IMAGE_BUDGET_BYTES = 3 * MB;
/** DOCX 미리보기 HTML 응답 상한(Vercel 응답 본문 4.5MB 안). 넘으면 미리보기 대신 원본 내려받기를 안내한다. */
export const DOCX_HTML_MAX_BYTES = 4 * MB;

/**
 * DOCX → 보기용 HTML 문서(mammoth). 압축 해제 상한을 먼저 확인한다. 결과는 SANDBOX_CSP로 내려주고 화면은 sandbox iframe에 넣는다
 * (스크립트가 돌 수 없다). 그래도 javascript: 같은 주소는 링크에서 뺀다.
 */
export async function docxToHtmlDocument(
  bytes: Uint8Array,
  title: string,
  opts: { maxImageBytes?: number } = {},
): Promise<string> {
  assertDocxWithinLimits(bytes);
  const mammoth = (await import("mammoth")).default;
  // mammoth는 그림을 base64 data URI로 본문에 넣는다. 응답 상한(DOCX_HTML_MAX_BYTES)을 넘지 않게 그림 합계를 묶고, 넘는 그림은 빼고 표시만 남긴다.
  let imageBudget = opts.maxImageBytes ?? DOCX_HTML_IMAGE_BUDGET_BYTES;
  let droppedImages = 0;
  const convertImage = mammoth.images.imgElement(async (image) => {
    const data = await image.read("base64");
    if (data.length > imageBudget || !/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(image.contentType)) {
      droppedImages += 1;
      // 빈 src는 아래에서 지워진다(그림 자리는 비고 머리말에 생략 안내를 둔다).
      return { src: "" };
    }
    imageBudget -= data.length;
    return { src: `data:${image.contentType};base64,${data}` };
  });
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, { convertImage });
  const body = result.value.replace(/\s(href|src)="(?!https?:|#|data:image\/)[^"]*"/gi, "");
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.65;color:#1f2937;margin:0 auto;padding:24px;max-width:820px;word-break:keep-all;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #d1d5db;padding:4px 8px;vertical-align:top}
h1,h2,h3{line-height:1.3}a{color:#4338ca}
.note{font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px}
</style></head><body>${
    droppedImages ? `<p class="note">그림 ${droppedImages}개는 미리보기에서 뺐습니다(크기 상한). 원본을 내려받아 확인해 주세요.</p>` : ""
  }${body || "<p>표시할 내용이 없습니다.</p>"}</body></html>`;
}
