import { clientIp, shareLimiter } from "@/lib/auth/rate-limit";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { reportPdfResponse } from "@/lib/diagnoses/pdf-response";
import { getDiagnosisByShareToken } from "@/lib/diagnoses/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 공유 링크의 PDF. 로그인 없이 토큰만으로 읽는다. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const limit = shareLimiter.hit(clientIp(req));
  if (!limit.ok) {
    return Response.json(
      { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }
  const { token } = await params;

  try {
    const found = await getDiagnosisByShareToken(token);
    if (!found) return jsonError("공유 링크가 없거나 해제되었습니다.", 404);
    // 렌더링 결과는 pdf-response의 메모리 캐시에서 재사용하고, ETag가 같으면 304.
    return await reportPdfResponse(found, {
      shared: true,
      ifNoneMatch: req.headers.get("if-none-match"),
      extraHeaders: { "X-Robots-Tag": "noindex, nofollow" },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/share/[token]/pdf");
  }
}
