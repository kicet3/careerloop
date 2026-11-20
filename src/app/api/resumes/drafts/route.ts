import { requireApiUser } from "@/lib/auth/session";
import { draftErrorResponse, noStore } from "@/lib/resumes/draft-http";
import { agentJobsNeedingKick } from "@/lib/resume-agent/jobs";
import { listVisibleDraftJobs } from "@/lib/resumes/draft-jobs";

export const runtime = "nodejs";

/** 이력서 목록에 보일 초안 작업(진행 중 + 최근 하루 안에 실패한 것). agentKicks: 이어 가기가 필요한 에이전트 작업 id(목록 화면이 …/advance를 보낸다). */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const items = await listVisibleDraftJobs(user.id);
    const agentKicks = items.some((j) => j.mode === "agent" && j.status === "running") ? await agentJobsNeedingKick(user.id).catch(() => []) : [];
    return Response.json({ items, agentKicks }, { headers: noStore });
  } catch (err) {
    return draftErrorResponse(err, "GET /api/resumes/drafts");
  }
}
