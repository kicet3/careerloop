import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { POSTING_STATUSES, PostingCreateInputSchema, type PostingStatus } from "@/lib/domain/postings";
import { MAX_POSTING_BODY_BYTES, postingErrorResponse, postingWriteLimiter, tooManyRequests } from "@/lib/postings/http";
import { createPosting, listPostings } from "@/lib/postings/service";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

/** 보관한 공고 목록(JD 원문 제외). ?status=로 상태를 고를 수 있다. */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const status = new URL(req.url).searchParams.get("status");
  try {
    const items = await listPostings(user.id, {
      status: status && (POSTING_STATUSES as readonly string[]).includes(status) ? (status as PostingStatus) : undefined,
    });
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/postings");
  }
}

/** 공고 직접 추가. 같은 URL이 이미 있으면 409 { existingId }. */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limit = postingWriteLimiter.hit(user.id);
  if (!limit.ok) return tooManyRequests("요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", limit.retryAfterSec);
  try {
    const input = await readJsonInput(req, PostingCreateInputSchema, MAX_POSTING_BODY_BYTES);
    const posting = await createPosting(user.id, input);
    return Response.json({ posting }, { status: 201 });
  } catch (err) {
    return postingErrorResponse(err, "POST /api/postings");
  }
}
