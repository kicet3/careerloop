import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson } from "@/lib/chat/graph-chat";
import { scheduleQaReply, startQaMessage } from "@/lib/chat/graph-qa";
import { jsonError } from "@/lib/diagnoses/http";
import { ChatUserMessageSchema, MAX_QA_QUESTION_CHARS } from "@/lib/domain/chat";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// after()로 이어지는 답변(검색·리랭크·LLM)이 이 시간 안에 끝나야 한다. REPLY_TIMEOUT_MS(270초)와 맞춘다.
export const maxDuration = 300;

const BodySchema = z.object({ message: z.string(), provider: z.string().max(40).nullish() });

/** 질문을 저장하고 202. 답변(출처 포함)은 백그라운드에서 만들어 스레드에 추가된다 — 클라이언트는 스레드를 폴링한다. */
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
    const text = ChatUserMessageSchema.safeParse(body.data.message);
    if (!text.success || text.data.length > MAX_QA_QUESTION_CHARS) {
      return jsonError(body.data.message.trim() ? `질문은 ${MAX_QA_QUESTION_CHARS}자까지 보낼 수 있습니다.` : "질문을 입력해 주세요.", 400);
    }
    const provider = await resolveRequestedProvider(body.data.provider ?? null);
    const message = await startQaMessage(user.id, threadId, text.data);
    scheduleQaReply(user.id, threadId, provider, user.name, startedAt);
    return Response.json({ message }, { status: 202 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/qa/threads/[threadId]/messages");
  }
}
