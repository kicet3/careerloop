import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { createGraphThread, listGraphThreads, readSmallJson } from "@/lib/chat/graph-chat";
import { ensureDatabase } from "@/lib/db/migrate";
import { graphEnabled } from "@/lib/graph/service";
import { jsonError } from "@/lib/diagnoses/http";

export const runtime = "nodejs";

/** 그래프 채팅 스레드 목록(최근 순). */
export async function GET() {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const threads = await listGraphThreads(user.id);
    return Response.json({ threads, graphEnabled: graphEnabled() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/graph/chat/threads");
  }
}

const CreateSchema = z.object({ title: z.string().max(200).nullish() });

/** 새 스레드. 제목을 비우면 첫 메시지로 정해진다. */
export async function POST(req: Request) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const body = CreateSchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    const thread = await createGraphThread(user.id, body.data.title);
    return Response.json({ thread }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/chat/threads");
  }
}
