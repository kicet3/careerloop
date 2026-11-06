import { z } from "zod";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson, scheduleGraphChatReply } from "@/lib/chat/graph-chat";
import { jsonError } from "@/lib/diagnoses/http";
import { githubErrorResponse, requireGithubConfigured } from "@/lib/github/http";
import { startGithubImport } from "@/lib/github/import";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// after()로 이어지는 LLM 답변이 이 시간 안에 끝나야 한다. graph-chat.ts REPLY_TIMEOUT_MS(270초)와 맞춘다.
export const maxDuration = 300;

const BodySchema = z.object({
  fullName: z.string().min(3).max(200),
  /** 이을 Project 노드 id 또는 "new" */
  projectNodeId: z.string().min(1).max(64),
  /** true면 저장소 정보를 새로 읽고 다시 정리한다. */
  refresh: z.boolean().optional(),
  /** 지금 보고 있는 프로젝트 대화('새 정보로 다시 정리'는 그 대화에 이어 쓴다). */
  threadId: z.string().min(1).max(64).nullish(),
  provider: z.string().max(40).nullish(),
});

/**
 * GitHub 저장소로 프로젝트 정리 시작: 프로젝트를 고르거나 만들고 저장소를 이은 뒤, 그 프로젝트 대화에 가져오기 메시지를 저장하고 202.
 * 변경안·후속 질문은 백그라운드에서 만들어 스레드에 추가된다(클라이언트는 폴링).
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cfg = requireGithubConfigured();
  if (cfg instanceof Response) return cfg;
  try {
    const body = BodySchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const provider = await resolveRequestedProvider(body.data.provider ?? null);
    const result = await startGithubImport(user.id, body.data);
    scheduleGraphChatReply(user.id, result.thread.id, provider, user.name, startedAt);
    return Response.json(result, { status: 202 });
  } catch (err) {
    return githubErrorResponse(err, "POST /api/graph/chat/github-import");
  }
}
