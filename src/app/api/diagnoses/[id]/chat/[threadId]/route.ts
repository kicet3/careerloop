/**
 * 심사위원 대화 하나.
 * GET    → { thread, messages }  (오래된 순)
 * DELETE → 204
 */
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { deleteReviewerThread, getReviewerThread } from "@/lib/chat/reviewer-chat";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; threadId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, threadId } = await params;

  try {
    const body = await getReviewerThread(user.id, id, threadId);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/diagnoses/[id]/chat/[threadId]");
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, threadId } = await params;

  try {
    await deleteReviewerThread(user.id, id, threadId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/diagnoses/[id]/chat/[threadId]");
  }
}
