import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { followupCounts, listFollowups } from "@/lib/chat/followups";
import { jsonError } from "@/lib/diagnoses/http";
import { FOLLOWUP_STATUSES, type FollowupStatus } from "@/lib/domain/followups";

export const runtime = "nodejs";

/**
 * 후속 질문. 항상 열린 질문 수(counts: 프로젝트별·미지정)를 돌려준다.
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
