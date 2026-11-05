import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { applyGraphProposal } from "@/lib/chat/graph-chat";

export const runtime = "nodejs";

/**
 * 변경안 적용. 성공: { message(status=applied), result }. 그래프가 바뀌어 적용할 수 없으면 { message(status=failed), result: null }
 * (200 — 메시지 상태로 알린다). 이미 처리된 변경안은 409.
 */
export async function POST(req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { messageId } = await params;
  try {
    const out = await applyGraphProposal(user.id, messageId);
    return Response.json(out);
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/messages/[messageId]/apply");
  }
}
