import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { followupCounts, listFollowups, reconcileProjectFollowups } from "@/lib/chat/followups";
import { jsonError } from "@/lib/diagnoses/http";
import { FOLLOWUP_STATUSES, type FollowupStatus } from "@/lib/domain/followups";
import { assertGraphOwner } from "@/lib/graph/owner";
import { getCareerGraph, graphEnabled } from "@/lib/graph/service";

export const runtime = "nodejs";

/**
 * 후속 질문. 항상 열린 질문 수(counts: 프로젝트별·미지정)를 돌려준다. 프로젝트를 주면 그 프로젝트의 열린 질문 중 이미 채운 것·
 * 이미 답한 것을 바꿔 묻는 질문을 먼저 정리한다(reconcileProjectFollowups).
 * - ?projectNodeId=<id>: 그 프로젝트의 질문(items)
 * - ?unassigned=1: 프로젝트 미지정 질문(items)
 * - &status=open|answered|skipped|all(기본 open)
 */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const url = new URL(req.url);
    const projectNodeId = url.searchParams.get("projectNodeId");
    const unassigned = url.searchParams.get("unassigned") === "1";
    const statusParam = url.searchParams.get("status") ?? "open";
    if (projectNodeId !== null && (projectNodeId.length === 0 || projectNodeId.length > 64)) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    if (statusParam !== "all" && !(FOLLOWUP_STATUSES as readonly string[]).includes(statusParam)) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const statuses = statusParam === "all" ? undefined : [statusParam as FollowupStatus];
    if (projectNodeId !== null && graphEnabled()) {
      // 이미 채운 것·이미 답한 것을 바꿔 묻는 열린 질문을 정리한 뒤 센다(그래프를 못 읽으면 그대로 보여 준다).
      await getCareerGraph(user.id)
        .then((graph) => reconcileProjectFollowups(user.id, assertGraphOwner(graph, user.id), [projectNodeId]))
        .catch((err) => console.error("[graph followups reconcile]", err));
    }
    const counts = await followupCounts(user.id);
    const items =
      projectNodeId !== null || unassigned
        ? await listFollowups(user.id, { projectNodeId: projectNodeId ?? null, statuses })
        : undefined;
    return Response.json({ counts, ...(items ? { items } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/graph/chat/followups");
  }
}
