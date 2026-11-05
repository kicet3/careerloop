import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { skillGapAcrossPostings } from "@/lib/graph/match-service";

export const runtime = "nodejs";

/** 보관한 공고(마감 제외)들이 요구하지만 내 경력 그래프에 없는 기술 Top N. 그래프 저장소가 꺼져 있으면 503. */
export async function GET() {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  try {
    const body = await skillGapAcrossPostings(user.id);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/insights/skills");
  }
}
