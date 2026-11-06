import { requireApiUser } from "@/lib/auth/session";
import { draftErrorResponse, noStore } from "@/lib/resumes/draft-http";
import { listVisibleDraftJobs } from "@/lib/resumes/draft-jobs";

export const runtime = "nodejs";

/** 이력서 목록에 보일 초안 작업(진행 중 + 최근 하루 안에 실패한 것). */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json({ items: await listVisibleDraftJobs(user.id) }, { headers: noStore });
  } catch (err) {
    return draftErrorResponse(err, "GET /api/resumes/drafts");
  }
}
