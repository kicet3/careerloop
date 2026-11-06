import { jsonError } from "@/lib/diagnoses/http";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { assertDraftLimit, draftErrorResponse, noStore, scheduleDraftJob } from "@/lib/resumes/draft-http";
import { DRAFT_JOB_NOT_FOUND, restartDraftJob } from "@/lib/resumes/draft-jobs";

export const runtime = "nodejs";
// after()로 이어지는 초안 실행의 시간 상한(POST /api/resumes와 같다 — draft-jobs.ts DRAFT_ROUTE_MAX_DURATION_SEC).
export const maxDuration = 300;

/** 실패했거나 멈춘 초안 작업을 같은 입력으로 다시 실행한다(202). 진행 중이거나 완성됐으면 409, 남의 작업이면 404. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const started = await restartDraftJob(user.id, id.slice(0, 64), { beforeRestart: () => assertDraftLimit(user.id) });
    if (!started) return jsonError(DRAFT_JOB_NOT_FOUND, 404);
    scheduleDraftJob(user.id, started.job.id, started.runId, started.provider);
    return Response.json({ draftJob: started.job }, { status: 202, headers: noStore });
  } catch (err) {
    return draftErrorResponse(err, "POST /api/resumes/drafts/[id]/retry");
  }
}
