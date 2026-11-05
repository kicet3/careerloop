import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { PostingUpdateInputSchema } from "@/lib/domain/postings";
import { MAX_POSTING_BODY_BYTES, postingErrorResponse, postingNotFound, postingWriteLimiter, tooManyRequests } from "@/lib/postings/http";
import { deletePosting, getPosting, listPostingLinks, updatePosting } from "@/lib/postings/service";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 공고 + 이 공고로 만든 진단·이력서. */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const posting = await getPosting(user.id, id);
    if (!posting) return postingNotFound();
    const links = await listPostingLinks(user.id, id);
    return Response.json({ posting, links }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/postings/[id]");
  }
}

/** 메타·상태·JD 수정(보낸 필드만). */
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limit = postingWriteLimiter.hit(user.id);
  if (!limit.ok) return tooManyRequests("요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", limit.retryAfterSec);
  const { id } = await params;
  try {
    const patch = await readJsonInput(req, PostingUpdateInputSchema, MAX_POSTING_BODY_BYTES);
    const posting = await updatePosting(user.id, id, patch);
    if (!posting) return postingNotFound();
    return Response.json({ posting });
  } catch (err) {
    return postingErrorResponse(err, "PATCH /api/postings/[id]");
  }
}

/** 공고 삭제. 연결된 진단·이력서·지원 기록은 남고 공고 연결만 끊긴다. */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    if (!(await deletePosting(user.id, id))) return postingNotFound();
    return new Response(null, { status: 204 });
  } catch (err) {
    return postingErrorResponse(err, "DELETE /api/postings/[id]");
  }
}
