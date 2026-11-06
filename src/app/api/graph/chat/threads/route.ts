import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { createFocusedGraphThread, createGraphThread, listGraphThreads, openFocusedGraphThread, readSmallJson } from "@/lib/chat/graph-chat";
import { graphEnabled } from "@/lib/graph/service";
import { jsonError } from "@/lib/diagnoses/http";

export const runtime = "nodejs";

/** 그래프 채팅 스레드 목록(최근 순). */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const threads = await listGraphThreads(user.id);
    return Response.json({ threads, graphEnabled: graphEnabled() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/graph/chat/threads");
  }
}

const CreateSchema = z.object({
  title: z.string().max(200).nullish(),
  /** 프로젝트 단위 대화: 구조화할 Project 노드 id. 주면 제목은 프로젝트 이름이 된다(title은 무시). */
  focusNodeId: z.string().min(1).max(64).nullish(),
  /** focusNodeId와 함께: 그 프로젝트의 최근 대화가 있으면 새로 만들지 않고 돌려준다(200, created=false). */
  reuse: z.boolean().optional(),
});

/**
 * 새 스레드. 제목을 비우면 첫 메시지로 정해진다. focusNodeId를 주면 그 프로젝트에 집중한 대화(없는 프로젝트면 404).
 * reuse=true면 그 프로젝트의 최근 대화를 돌려준다(없을 때만 만든다).
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const body = CreateSchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    if (body.data.focusNodeId && body.data.reuse) {
      const { thread, created } = await openFocusedGraphThread(user.id, body.data.focusNodeId);
      return Response.json({ thread, created }, { status: created ? 201 : 200 });
    }
    const thread = body.data.focusNodeId
      ? await createFocusedGraphThread(user.id, body.data.focusNodeId)
      : await createGraphThread(user.id, body.data.title);
    return Response.json({ thread, created: true }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/threads");
  }
}
