import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { IngestError } from "@/lib/ingest/extract";
import { portfolioNotFound } from "@/lib/portfolios/http";
import {
  DOCX_HTML_MAX_BYTES,
  docxToHtmlDocument,
  ORIGINAL_PRESIGN_TTL_SEC,
  ORIGINAL_PROXY_MAX_BYTES,
  originalResponseHeaders,
  originalServeSpec,
  SANDBOX_CSP,
} from "@/lib/portfolios/original";
import { getPortfolioOriginalRef } from "@/lib/portfolios/service";
import { getObject, presignGetObject, storageKind } from "@/lib/storage";

export const runtime = "nodejs";
// 큰 원본(최대 30MB)을 저장소에서 읽어 내려주거나 DOCX를 HTML로 바꾸는 시간.
export const maxDuration = 60;

/**
 * 보관한 원본 파일(소유자만 — 남의 것·원본이 없는 항목은 404). 화면의 원본 보기(PDF iframe·이미지·DOCX 미리보기)와 내려받기에 쓴다.
 * - 기본: PDF·이미지·TXT/MD는 inline, 그 밖(HTML·DOCX·HWP·HWPX)은 application/octet-stream 첨부. 늘 nosniff·private no-store,
 *   PDF 밖은 CSP sandbox(우리 출처에서 올린 내용이 스크립트로 돌지 않는다). HTML은 어떤 경우에도 text/html로 내려주지 않는다.
 * - ?download=1: 늘 첨부.
 * - ?view=html: DOCX를 서버에서 HTML로 바꿔 CSP sandbox로 내려준다(화면은 sandbox iframe으로 넣는다). DOCX가 아니면 400.
 *   그림은 합계 상한까지만 넣고, 결과가 응답 상한(DOCX_HTML_MAX_BYTES)을 넘으면 422(원본 내려받기 안내).
 * - 저장소가 R2이고 원본이 ORIGINAL_PROXY_MAX_BYTES(4MB)보다 크면 본문을 싣지 않고 소유자 확인 뒤 60초짜리 서명 GET 주소로 302
 *   (Vercel 응답 본문 4.5MB 상한). 서명에 내용 유형(HTML은 octet-stream)·Content-Disposition·Cache-Control을 넣는다.
 *   R2는 다른 출처라 우리 쿠키·화면에 닿지 않는다 — 그래도 TXT·MD는 그쪽에서 inline으로 열지 않고 첨부로 보낸다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const url = new URL(req.url);
  try {
    const ref = await getPortfolioOriginalRef(user.id, id.slice(0, 64));
    if (!ref) return portfolioNotFound();

    if (url.searchParams.get("view") === "html") {
      if (ref.portfolio.original?.view !== "docx") return jsonError("DOCX 파일만 HTML로 볼 수 있습니다.", 400);
      const bytes = await getObject(ref.key);
      if (!bytes) return portfolioNotFound();
      let html: string;
      try {
        html = await docxToHtmlDocument(bytes, ref.fileName);
      } catch (err) {
        if (err instanceof IngestError) return jsonError(err.message, err.status);
        console.error("[GET /api/portfolios/[id]/original] DOCX 변환 실패", err);
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
        },
      });
    }

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
          headers: { Location: signed, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
        });
      }
    }

    const bytes = await getObject(ref.key);
    if (!bytes) return portfolioNotFound();
    const headers = originalResponseHeaders({ mime: ref.mime, size: bytes.byteLength, fileName: ref.fileName, download });
    return new Response(new Uint8Array(bytes), { headers });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/portfolios/[id]/original");
  }
}
