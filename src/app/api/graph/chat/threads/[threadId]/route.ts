import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { getGraphThreadView, readSmallJson, renameGraphThread } from "@/lib/chat/graph-chat";
import { deleteThread, getThread } from "@/lib/chat/store";
import { jsonError } from "@/lib/diagnoses/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ threadId: string }> };

/** 스레드와 메시지 전체, 답변 대기 상태(pending·stale·canRetry). 답변을 기다리는 동안 클라이언트가 폴링한다. */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  try {
    const view = await getGraphThreadView(user.id, threadId, user.name);
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/graph/chat/threads/[threadId]");
  }
}

const RenameSchema = z.object({ title: z.string().min(1).max(200) });

export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  try {
    const body = RenameSchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("대화 제목을 입력해 주세요.", 400);
    const thread = await renameGraphThread(user.id, threadId, body.data.title);
    return Response.json({ thread });
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/graph/chat/threads/[threadId]");
  }
}

/** 대화만 지운다. 이미 적용한 그래프 변경은 그대로 남는다. */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  try {
    const thread = await getThread(user.id, threadId);
    if (!thread || thread.kind !== "graph") return jsonError("대화를 찾을 수 없습니다.", 404);
    await deleteThread(user.id, threadId);
    return new Response(null, { status: 204 });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/graph/chat/threads/[threadId]");
  }
}
