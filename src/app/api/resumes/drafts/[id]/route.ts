import { jsonError } from "@/lib/diagnoses/http";
import { requireApiUser } from "@/lib/auth/session";
import { draftErrorResponse, noStore } from "@/lib/resumes/draft-http";
import { DRAFT_JOB_NOT_FOUND, getDraftJob } from "@/lib/resumes/draft-jobs";

export const runtime = "nodejs";

/** 초안 작업 상태(진행 화면이 폴링한다). 멈춘 작업은 이때 실패로 닫힌다. 남의 작업이면 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const job = await getDraftJob(user.id, id.slice(0, 64));
    if (!job) return jsonError(DRAFT_JOB_NOT_FOUND, 404);
    return Response.json({ draftJob: job }, { headers: noStore });
  } catch (err) {
    return draftErrorResponse(err, "GET /api/resumes/drafts/[id]");
  }
}
