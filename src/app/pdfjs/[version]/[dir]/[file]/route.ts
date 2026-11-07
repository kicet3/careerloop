import { readFile } from "node:fs/promises";
import path from "node:path";
import { pdfjsAssetContentType, pdfjsAssetFile } from "@/lib/portfolios/pdfjs-assets";

export const runtime = "nodejs";

/**
 * 화면 PDF 보기(PdfViewer)가 쓰는 pdf.js 정적 자산을 node_modules/pdfjs-dist에서 그대로 내려준다:
 * 워커(build/pdf.worker.min.mjs — legacy 빌드), 한국어 CID 글꼴 CMap(cmaps), 표준 글꼴(standard_fonts), JPX·JBIG2 디코더(wasm), ICC(iccs).
 * 번들러(Turbopack·webpack)마다 다른 워커 주소 처리를 피하고 API와 워커 판이 늘 같게 한다.
 * 주소에 pdfjs-dist 판을 넣고 판이 다르면 404 — 그래서 오래 캐시해도 된다(public, immutable). 파일 이름은 목록(pdfjs-assets.ts)으로만 고른다.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ version: string; dir: string; file: string }> }) {
  const { version, dir, file } = await params;
  const rel = pdfjsAssetFile(version, dir, file);
  if (!rel) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  let body: Buffer;
  try {
    body = await readFile(path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "pdfjs-dist", ...rel.split("/")));
  } catch {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": pdfjsAssetContentType(file),
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}
