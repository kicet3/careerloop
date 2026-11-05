import { requireApiUser } from "@/lib/auth/session";
import { SharedPostingListQuerySchema } from "@/lib/domain/shared-postings";
import { jsonError } from "@/lib/diagnoses/http";
import { postingErrorResponse } from "@/lib/postings/http";
import { listSharedPostings } from "@/lib/postings/shared";

export const runtime = "nodejs";

/** 공고 찾기 목록(승인된 사용자 모두). 각 공고에 내 보관함 공고 id(myPostingId)를 싣는다. 관리자는 ?hidden=only로 숨긴 공고를 본다. */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const parsed = SharedPostingListQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return jsonError("검색 조건이 올바르지 않습니다.", 400);
  try {
    // 숨긴 공고 목록은 관리자만(일반 사용자의 hidden=only는 무시한다).
    const hidden = user.role === "admin" ? parsed.data.hidden : undefined;
    const result = await listSharedPostings({ ...parsed.data, hidden, viewerId: user.id });
    return Response.json({ ...result, page: parsed.data.page }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/shared-postings");
  }
}
