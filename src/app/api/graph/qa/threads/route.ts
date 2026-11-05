import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson } from "@/lib/chat/graph-chat";
import { createQaThread, listQaThreads } from "@/lib/chat/graph-qa";
import { jsonError } from "@/lib/diagnoses/http";
import { graphEnabled } from "@/lib/graph/service";

export const runtime = "nodejs";

/** 그래프에 묻기 스레드 목록(최근 순). */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const threads = await listQaThreads(user.id);
    return Response.json({ threads, graphEnabled: graphEnabled() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/graph/qa/threads");
  }
}

const CreateSchema = z.object({ title: z.string().max(200).nullish() });

/** 새 스레드. 제목을 비우면 첫 질문으로 정해진다. */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const body = CreateSchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const thread = await createQaThread(user.id, body.data.title);
    return Response.json({ thread }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/qa/threads");
  }
}
