import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { requireThread, scheduleGraphChatReply, startGraphImportMessage } from "@/lib/chat/graph-chat";
import { parseImportForm } from "@/lib/chat/graph-import";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { jsonError } from "@/lib/diagnoses/http";
import { uploadLimitMessage, uploadLimitsFor } from "@/lib/ingest/upload-limits";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// after()로 이어지는 LLM 답변이 이 시간 안에 끝나야 한다. graph-chat.ts REPLY_TIMEOUT_MS(270초)와 맞춘다.
export const maxDuration = 300;

/**
 * 이력서·포트폴리오로 그래프 채우기. multipart: file(PDF·DOCX·HWP·HWPX·HTML·TXT·MD) 또는 text, docKind(resume|portfolio), provider.
 * 읽어 낸 글을 사용자 메시지로 저장하고 202 — 변경안은 백그라운드에서 만들어 스레드에 추가된다(클라이언트는 폴링).
 * 원본 파일은 저장하지 않는다.
 */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { threadId } = await params;
  const limits = uploadLimitsFor();
  try {
    // 파일을 읽기 전에 내 스레드인지 먼저 본다.
    await requireThread(user.id, threadId, "graph");
    let form: FormData;
    try {
      form = await readFormDataLimited(req, limits.maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return jsonError(`업로드 용량이 너무 큽니다. ${uploadLimitMessage(limits)}`, 413);
      return jsonError("요청 형식이 올바르지 않습니다. multipart/form-data로 보내 주세요.", 400);
    }
    const doc = await parseImportForm(form, limits);
    const providerRaw = form.get("provider");
    const provider = await resolveRequestedProvider(typeof providerRaw === "string" ? providerRaw.slice(0, 40) : null);
    const message = await startGraphImportMessage(user.id, threadId, doc);
    scheduleGraphChatReply(user.id, threadId, provider, user.name, startedAt);
    // 응답에는 읽어 낸 글을 다시 싣지 않는다.
    const view = message.data?.kind === "document-import" ? { ...message, data: { ...message.data, text: "" } } : message;
    return Response.json({ message: view, warnings: doc.warnings }, { status: 202 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/threads/[threadId]/import");
  }
}
