import { ensureDatabase } from "@/lib/db/migrate";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { reportPdfResponse } from "@/lib/diagnoses/pdf-response";
import { getDiagnosisByShareToken } from "@/lib/diagnoses/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 공유 링크의 PDF. 로그인 없이 토큰만으로 읽는다. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  await ensureDatabase();
  const { token } = await params;

  try {
    const found = await getDiagnosisByShareToken(token);
    if (!found) return jsonError("공유 링크가 없거나 해제되었습니다.", 404);
    return await reportPdfResponse(found, { "X-Robots-Tag": "noindex, nofollow" });
  } catch (err) {
    return errorResponse(err, "GET /api/share/[token]/pdf");
  }
}
