import { requireApiUser } from "@/lib/auth/session";
import { featureErrorResponse } from "@/lib/api/errors";
import { jsonError } from "@/lib/diagnoses/http";
import { getCareerGraph, graphEnabled } from "@/lib/graph/service";
import type { GraphResponse } from "@/components/graph/api";

export const runtime = "nodejs";

/** 로그인 사용자의 경험 그래프 전체. Neo4j가 설정되지 않았으면 503. */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  if (!graphEnabled()) return jsonError("경험 그래프 저장소(Neo4j)가 설정되지 않았습니다.", 503);

  try {
    const graph = await getCareerGraph(user.id, { personName: user.name });
    const body: GraphResponse = { graph };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/graph");
  }
}
