import { jsonError } from "@/lib/diagnoses/http";
import { requireApiUser } from "@/lib/auth/session";
import { agentErrorResponse, noStore } from "@/lib/resume-agent/http";
import { AGENT_JOB_NOT_FOUND, getAgentJob } from "@/lib/resume-agent/jobs";

export const runtime = "nodejs";

/** 에이전트 작업 진행 상태(진행 화면이 폴링한다). 리스 만료·24시간 멈춤은 이때 판정한다. needsKick이면 화면이 …/advance를 보낸다. 남의 작업이면 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const job = await getAgentJob(user.id, id.slice(0, 64));
    if (!job) return jsonError(AGENT_JOB_NOT_FOUND, 404);
    return Response.json({ agentJob: job }, { headers: noStore });
  } catch (err) {
    return agentErrorResponse(err, "GET /api/resumes/agent-jobs/[id]");
  }
}
