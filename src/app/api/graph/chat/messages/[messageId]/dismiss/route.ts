import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { dismissGraphProposal } from "@/lib/chat/graph-chat";

export const runtime = "nodejs";

/** 변경안 거절(proposed → dismissed). 이미 처리된 변경안은 409. */
export async function POST(req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { messageId } = await params;
  try {
    const message = await dismissGraphProposal(user.id, messageId);
    return Response.json({ message });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/messages/[messageId]/dismiss");
  }
}
