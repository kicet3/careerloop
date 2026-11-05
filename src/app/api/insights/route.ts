import { featureErrorResponse } from "@/lib/api/errors";
import { getInsights } from "@/lib/applications/insights-service";
import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import type { InsightsResponse } from "@/lib/domain/applications";

export const runtime = "nodejs";

/** 지원 성과 집계(응답률·단계 도달·이력서 버전별·회사별)와 행동 제안. 실제 결과만 센다. */
export async function GET() {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const insights: InsightsResponse = await getInsights(user.id);
    return Response.json(insights, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/insights");
  }
}
