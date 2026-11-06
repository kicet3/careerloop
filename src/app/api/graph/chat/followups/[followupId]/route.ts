import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson } from "@/lib/chat/graph-chat";
import { followupCounts, updateFollowup } from "@/lib/chat/followups";
import { jsonError } from "@/lib/diagnoses/http";
import { FOLLOWUP_STATUSES } from "@/lib/domain/followups";
import { getCareerGraph, graphEnabled, GraphUnavailableError } from "@/lib/graph/service";

export const runtime = "nodejs";

const PatchSchema = z.object({
  /** skipped(건너뛰기)·open(다시 열기)·answered(답함으로 표시). */
  status: z.enum(FOLLOWUP_STATUSES).optional(),
  /** 프로젝트 지정(Project 노드 id). null이면 프로젝트 미지정으로. */
  projectNodeId: z.string().min(1).max(64).nullable().optional(),
});

/** 후속 질문 상태 바꾸기·프로젝트 지정. 응답: { followup, counts }. 남의 질문·없는 질문은 404, 같은 열린 질문이 있으면 409. */
export async function PATCH(req: Request, { params }: { params: Promise<{ followupId: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { followupId } = await params;
  try {
    const body = PatchSchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const followup = await updateFollowup(user.id, followupId, body.data, {
      getGraph: async (userId) => {
        if (!graphEnabled()) throw new GraphUnavailableError();
        return getCareerGraph(userId);
      },
    });
    const counts = await followupCounts(user.id);
    return Response.json({ followup, counts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/graph/chat/followups/[followupId]");
  }
}
