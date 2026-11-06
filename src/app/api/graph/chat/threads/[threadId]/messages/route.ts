import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson, scheduleGraphChatReply, startGraphChatMessage } from "@/lib/chat/graph-chat";
import { jsonError } from "@/lib/diagnoses/http";
import { ChatUserMessageSchema, MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// after()로 이어지는 LLM 답변(CLI 엔진은 수 분)이 이 시간 안에 끝나야 한다. graph-chat.ts REPLY_TIMEOUT_MS(270초)와 맞춘다.
export const maxDuration = 300;

const BodySchema = z.object({
  message: z.string(),
  provider: z.string().max(40).nullish(),
  /** 이 메시지가 답하는 후속 질문(graph_followups.id). 답으로 나온 변경안을 적용하면 그 질문이 answered가 된다. */
  followupId: z.string().min(1).max(64).nullish(),
});

/**
 * 사용자 메시지를 저장하고 202. 답변(변경안)은 백그라운드에서 만들어 스레드에 추가된다 — 클라이언트는 스레드를 폴링한다.
 * followupId가 열린 내 후속 질문이 아니면 404·409, 다른 프로젝트의 질문이면 400.
 */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  // 답변 마감은 요청 시작부터 센다(Vercel maxDuration도 요청 시작부터 잰다).
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  try {
    const body = BodySchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const text = ChatUserMessageSchema.safeParse(body.data.message);
    if (!text.success) {
      return jsonError(body.data.message.trim() ? `메시지는 ${MAX_CHAT_MESSAGE_CHARS}자까지 보낼 수 있습니다.` : "메시지를 입력해 주세요.", 400);
    }
    const provider = await resolveRequestedProvider(body.data.provider ?? null);
    const message = await startGraphChatMessage(user.id, threadId, text.data, undefined, { followupId: body.data.followupId ?? null });
    scheduleGraphChatReply(user.id, threadId, provider, user.name, startedAt);
    return Response.json({ message }, { status: 202 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/threads/[threadId]/messages");
  }
}
