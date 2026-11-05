import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson } from "@/lib/chat/graph-chat";
import { scheduleQaReply, startQaRetry } from "@/lib/chat/graph-qa";
import { jsonError } from "@/lib/diagnoses/http";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// messages 라우트와 같다.
export const maxDuration = 300;

const BodySchema = z.object({ provider: z.string().max(40).nullish() });

/** 답변 실패·무응답 뒤 마지막 질문을 다시 보낸다. 202. */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  try {
    const body = BodySchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const provider = await resolveRequestedProvider(body.data.provider ?? null);
    const message = await startQaRetry(user.id, threadId);
    scheduleQaReply(user.id, threadId, provider, user.name, startedAt);
    return Response.json({ message }, { status: 202 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/qa/threads/[threadId]/retry");
  }
}
