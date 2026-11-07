import { featureErrorResponse } from "@/lib/api/errors";
import { serveStoredOriginal } from "@/lib/portfolios/original-serve";
import { publicShareNotFound, publicShareRateLimit } from "@/lib/portfolios/share-http";
import { findActiveShareByToken, toPublicView } from "@/lib/portfolios/shares";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 공개 링크의 원본 파일(로그인 없음). 소유자가 '원본 파일 보기'를 골라 공개한 파일의 공개 당시 사본만 내려준다.
 * 헤더 규칙은 소유자 라우트(GET /api/portfolios/[id]/original)와 같다(nosniff, PDF 밖 CSP sandbox, HTML은 inline 금지, private no-store) +
 * X-Robots-Tag noindex. 내려받는 이름은 'portfolio.<확장자>'(원래 파일 이름을 공개하지 않는다).
 * 없는 토큰·공개를 끈 것·바뀐 옛 토큰·원본을 공개하지 않은 것은 모두 같은 404.
 * ?viewer=1: 화면의 PDF 보기가 Range(206) 조각으로 받아 간다(original-serve.ts). 조각 요청마다 위 확인을 모두 다시 한다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  // PDF 보기(?viewer=1)는 Range 조각을 여러 번 받아 가므로 따로 센다. 조각마다 아래 공개 여부 확인을 다시 거친다(공개를 끄면 바로 404).
  const limited = publicShareRateLimit(req, new URL(req.url).searchParams.get("viewer") === "1" ? "viewer" : "original");
  if (limited) return limited;
  const { token } = await params;
  try {
    const share = await findActiveShareByToken(token);
    const original = share ? toPublicView(share).original : null;
    if (!share || !original || !share.originalKey) return publicShareNotFound();
    // 공개본 사본은 소유자의 포트폴리오 폴더 아래에만 있다(행과 키가 어긋나도 남의 객체를 내주지 않게).
    if (!share.originalKey.startsWith(`users/${share.userId}/portfolios/`)) return publicShareNotFound();
    const ext = share.originalKey.slice(share.originalKey.lastIndexOf(".") + 1);
    return await serveStoredOriginal(
      req,
      { key: share.originalKey, mime: original.mime, size: original.size, fileName: `portfolio.${ext}`, view: original.view },
      { notFound: publicShareNotFound, context: "GET /api/p/[token]/original", extraHeaders: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  } catch (err) {
    return featureErrorResponse(err, "GET /api/p/[token]/original");
  }
}
