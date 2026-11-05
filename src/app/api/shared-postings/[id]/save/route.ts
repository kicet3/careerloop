import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { postingErrorResponse, postingWriteLimiter, tooManyRequests } from "@/lib/postings/http";
import { saveSharedToLibrary } from "@/lib/postings/shared";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 공고 찾기의 공고를 내 보관함에 담는다(AI·페이지 읽기 없음). 새로 담으면 201, 이미 있던 공고면 200 { created: false }.
 */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limit = postingWriteLimiter.hit(user.id);
  if (!limit.ok) return tooManyRequests("요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", limit.retryAfterSec);
  const { id } = await params;
  try {
    const { posting, created } = await saveSharedToLibrary(user.id, id.slice(0, 64));
    return Response.json({ posting, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return postingErrorResponse(err, "POST /api/shared-postings/[id]/save");
  }
}
