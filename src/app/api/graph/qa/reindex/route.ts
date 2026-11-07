import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { reindexOwn } from "@/lib/rag/reindex";

export const runtime = "nodejs";
// 문서가 많으면 오래 걸린다(질문 경로와 따로 돈다). 사용자당 하루 3회.
export const maxDuration = 300;

/** 경험 질문하기 문서 다시 색인(본인 출처만 — 소유 조건으로 다시 읽어 청크를 만든다). */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const r = await reindexOwn(user.id);
    if (!r.ok) {
      return Response.json(
        { error: "문서 색인은 하루 3번까지 다시 할 수 있어요.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } },
      );
    }
    // 마감 안에 다 못 했으면 성공으로 알리지 않는다(색인 버전도 표시하지 않았다).
    return Response.json({ synced: r.synced, deleted: r.deleted, done: r.done });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/qa/reindex");
  }
}
