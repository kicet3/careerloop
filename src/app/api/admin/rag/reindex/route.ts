import { z } from "zod";
import { readJson } from "@/lib/auth/http";
import { assertSameOrigin, requireAdminApiUser } from "@/lib/auth/session";
import { reindexAll } from "@/lib/rag/reindex";

export const runtime = "nodejs";
export const maxDuration = 300;

const BodySchema = z.object({ userId: z.string().min(1).max(128).nullish(), cursor: z.string().min(1).max(128).nullish() });

/**
 * 경험 질문하기 문서 일괄 재색인(관리자). 마감(약 250초) 전까지 처리하고 다 못 하면 nextCursor를 돌려준다 — scripts/rag-reindex.mjs가 이어 부른다.
 * 응답에는 개수와 cursor(사용자 id)만 있다.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const admin = await requireAdminApiUser();
  if (admin instanceof Response) return admin;
  const body = BodySchema.safeParse((await readJson(req)) ?? {});
  if (!body.success) return Response.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  const r = await reindexAll({ userId: body.data.userId ?? null, cursor: body.data.cursor ?? null, deadlineAt: Date.now() + 250_000 });
  return Response.json(r);
}
