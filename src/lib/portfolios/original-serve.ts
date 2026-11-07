import "server-only";
/**
 * 보관한 포트폴리오 원본 내려주기(소유자 라우트 GET /api/portfolios/[id]/original와 공개 링크 라우트 GET /api/p/[token]/original 공용).
 * 호출자가 접근 확인(소유자 또는 공개 중인 공유)을 마친 키만 넘긴다. 헤더 규칙은 original.ts(originalServeSpec·originalResponseHeaders)와 같다:
 * - 늘 nosniff·private no-store, PDF 밖은 CSP sandbox, HTML은 어떤 경우에도 text/html로 내려주지 않는다.
 * - ?download=1: 늘 첨부. ?view=html: DOCX를 HTML로 바꿔 CSP sandbox로(화면은 sandbox iframe).
 * - 저장소가 R2이고 원본이 ORIGINAL_PROXY_MAX_BYTES보다 크면 60초짜리 서명 GET 주소로 302.
 * - ?viewer=1(PDF만, 화면의 PDF 보기 PdfViewer): 302 없이 우리 출처에서 Range 조각(206, 한 조각 ≤ ORIGINAL_VIEWER_RANGE_MAX_BYTES)으로 내려준다.
 *   R2 CORS는 PUT만 열어 두어 브라우저 fetch가 R2 서명 주소를 읽지 못하고, Vercel 응답 본문 상한(4.5MB) 안에 들도록 조각을 자른다.
 *   Range가 없으면 상한 이하 파일은 200 전체, 큰 파일은 400. 파일 밖 구간은 416(Content-Range: bytes *\/크기). 호출자는 요청마다
 *   접근 확인(소유자·공개 중인 공유)을 다시 한다 — 공개를 끄면 다음 조각부터 404.
 */
import { jsonError } from "@/lib/diagnoses/http";
import type { PortfolioOriginalView } from "@/lib/domain/portfolios";
import { IngestError } from "@/lib/ingest/extract";
import { getObject, getObjectRange, presignGetObject, storageKind } from "@/lib/storage";
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from "./byte-range";
import {
  DOCX_HTML_MAX_BYTES,
  docxToHtmlDocument,
  ORIGINAL_PRESIGN_TTL_SEC,
  ORIGINAL_PROXY_MAX_BYTES,
  originalResponseHeaders,
  originalServeSpec,
  SANDBOX_CSP,
} from "./original";

export interface StoredOriginal {
  key: string;
  mime: string;
  size: number;
  /** 내려받을 때의 파일 이름. */
  fileName: string;
  view: PortfolioOriginalView | null;
}

export async function serveStoredOriginal(
  req: Request,
  ref: StoredOriginal,
  opts: { notFound: () => Response; context: string; extraHeaders?: Record<string, string> },
): Promise<Response> {
  const url = new URL(req.url);
  const extra = opts.extraHeaders ?? {};

  if (url.searchParams.get("view") === "html") {
    if (ref.view !== "docx") return jsonError("DOCX 파일만 HTML로 볼 수 있습니다.", 400);
    const bytes = await getObject(ref.key);
    if (!bytes) return opts.notFound();
    let html: string;
    try {
      html = await docxToHtmlDocument(bytes, ref.fileName);
    } catch (err) {
      if (err instanceof IngestError) return jsonError(err.message, err.status);
      console.error(`[${opts.context}] DOCX 변환 실패`, err);
      return jsonError("DOCX를 화면에 보이지 못했습니다. 원본을 내려받아 확인해 주세요.", 422);
    }
    if (Buffer.byteLength(html, "utf8") > DOCX_HTML_MAX_BYTES) {
      return jsonError("DOCX 내용이 커서 화면 미리보기를 만들지 못했습니다. 원본을 내려받아 확인해 주세요.", 422);
    }
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": SANDBOX_CSP,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        ...extra,
      },
    });
  }

  if (url.searchParams.get("viewer") === "1") return serveViewerRange(req, ref, opts);

  const download = url.searchParams.get("download") === "1";
  if (ref.size > ORIGINAL_PROXY_MAX_BYTES && storageKind() === "r2") {
    const spec = originalServeSpec({ mime: ref.mime, fileName: ref.fileName, download, forceAttachmentForText: true });
    const signed = await presignGetObject(ref.key, {
      contentType: spec.contentType,
      contentDisposition: spec.disposition,
      cacheControl: "private, no-store",
      expiresIn: ORIGINAL_PRESIGN_TTL_SEC,
    });
    if (signed) {
      return new Response(null, {
        status: 302,
        headers: { Location: signed, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", ...extra },
      });
    }
  }

  const bytes = await getObject(ref.key);
  if (!bytes) return opts.notFound();
  const headers = originalResponseHeaders({ mime: ref.mime, size: bytes.byteLength, fileName: ref.fileName, download });
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(new Uint8Array(bytes), { headers });
}

/** PDF 보기용 Range 조각 하나의 상한(Vercel 응답 본문 4.5MB 안). 화면은 이보다 작게(1MB) 나눠 묻는다. */
export const ORIGINAL_VIEWER_RANGE_MAX_BYTES = ORIGINAL_PROXY_MAX_BYTES;

async function serveViewerRange(
  req: Request,
  ref: StoredOriginal,
  opts: { notFound: () => Response; context: string; extraHeaders?: Record<string, string> },
): Promise<Response> {
  const extra = opts.extraHeaders ?? {};
  if (ref.view !== "pdf") return jsonError("PDF 파일만 화면 보기로 열 수 있습니다.", 400);
  const parsed = parseRangeHeader(req.headers.get("range"), ref.size, ORIGINAL_VIEWER_RANGE_MAX_BYTES);
  const headersFor = (length: number) => {
    const h = originalResponseHeaders({ mime: ref.mime, size: length, fileName: ref.fileName, download: false });
    h.set("Accept-Ranges", "bytes");
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return h;
  };

  if (parsed.kind === "unsatisfiable") {
    const h = headersFor(0);
    h.delete("Content-Disposition");
    h.set("Content-Range", unsatisfiedRangeHeader(ref.size));
    return new Response(null, { status: 416, headers: h });
  }
  if (parsed.kind === "none") {
    if (ref.size > ORIGINAL_VIEWER_RANGE_MAX_BYTES) {
      return jsonError("큰 PDF는 Range 요청으로 나눠 받아야 합니다.", 400);
    }
    const bytes = await getObject(ref.key);
    if (!bytes) return opts.notFound();
    return new Response(new Uint8Array(bytes), { headers: headersFor(bytes.byteLength) });
  }

  const chunk = await getObjectRange(ref.key, parsed.start, parsed.end);
  if (!chunk) return opts.notFound();
  if (chunk.byteLength === 0) {
    // 보관한 크기(DB)보다 객체가 짧다 — 범위를 채울 수 없다.
    const h = headersFor(0);
    h.delete("Content-Disposition");
    h.set("Content-Range", unsatisfiedRangeHeader(ref.size));
    return new Response(null, { status: 416, headers: h });
  }
  const end = parsed.start + chunk.byteLength - 1;
  const h = headersFor(chunk.byteLength);
  h.set("Content-Range", contentRangeHeader(parsed.start, end, ref.size));
  return new Response(new Uint8Array(chunk), { status: 206, headers: h });
}
