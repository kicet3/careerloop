/**
 * 심사위원 채팅.
 * GET  ?reviewer=<id>  → { threads, available }  이 진단의 심사위원 대화 목록(최근 순)과 대화할 수 있는 심사위원
 * POST { reviewer, message, threadId? } → { thread, messages: [사용자, 답변] }  threadId가 없으면 새 대화
 * 본인 진단만(공유 링크로는 쓸 수 없다). 엔진은 진단을 돌린 엔진, 지금 쓸 수 없으면 사용 가능한 엔진.
 */
import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { listReviewerThreads, sendReviewerMessage } from "@/lib/chat/reviewer-chat";
import { BodyTooLargeError, readBodyLimited } from "@/lib/diagnoses/body";
import { jsonError } from "@/lib/diagnoses/http";
import { ChatUserMessageSchema, MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import { ReviewerIdSchema } from "@/lib/domain/schemas";

export const runtime = "nodejs";
// 계정 로그인(CLI) 엔진은 답이 느릴 수 있다.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const MAX_BODY_BYTES = MAX_CHAT_MESSAGE_CHARS * 4 + 1024;

const PostSchema = z.object({
  reviewer: ReviewerIdSchema,
  message: ChatUserMessageSchema,
  threadId: z.string().min(1).max(64).nullish(),
});

export async function GET(req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const raw = new URL(req.url).searchParams.get("reviewer");
  const reviewer = raw ? ReviewerIdSchema.safeParse(raw) : null;
  if (reviewer && !reviewer.success) return jsonError("알 수 없는 심사위원입니다.", 400);

  try {
    const body = await listReviewerThreads(user.id, id, reviewer?.data);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/diagnoses/[id]/chat");
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  let input: z.infer<typeof PostSchema>;
  try {
    const bytes = await readBodyLimited(req, MAX_BODY_BYTES);
    const parsed = PostSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some((i) => i.path[0] === "message" && i.code === "too_big");
      return jsonError(tooLong ? `메시지는 ${MAX_CHAT_MESSAGE_CHARS}자까지 보낼 수 있습니다.` : "요청 형식이 올바르지 않습니다.", 400);
    }
    input = parsed.data;
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(`메시지는 ${MAX_CHAT_MESSAGE_CHARS}자까지 보낼 수 있습니다.`, 413);
    return jsonError("요청 형식이 올바르지 않습니다.", 400);
  }

  try {
    const result = await sendReviewerMessage({
      userId: user.id,
      diagnosisId: id,
      reviewer: input.reviewer,
      threadId: input.threadId ?? null,
      message: input.message,
      signal: req.signal,
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/diagnoses/[id]/chat");
  }
}
