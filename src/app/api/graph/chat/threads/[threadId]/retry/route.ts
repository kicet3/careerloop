import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson, scheduleGraphChatReply, startGraphChatRetry } from "@/lib/chat/graph-chat";
import { ensureDatabase } from "@/lib/db/migrate";
import { jsonError } from "@/lib/diagnoses/http";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// messages 라우트와 같다.
export const maxDuration = 300;

const BodySchema = z.object({ provider: z.string().max(40).nullish() });

/** 답변 실패·무응답 뒤 마지막 메시지를 다시 보낸다. 202. */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  try {
    const body = BodySchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const provider = await resolveRequestedProvider(body.data.provider ?? null);
    const message = await startGraphChatRetry(user.id, threadId);
    scheduleGraphChatReply(user.id, threadId, provider, user.name);
    return Response.json({ message }, { status: 202 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/threads/[threadId]/retry");
  }
}
