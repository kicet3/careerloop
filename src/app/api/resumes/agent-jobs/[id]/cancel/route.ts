import { jsonError } from "@/lib/diagnoses/http";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { agentErrorResponse, noStore } from "@/lib/resume-agent/http";
import { AGENT_JOB_NOT_FOUND, cancelAgentJob } from "@/lib/resume-agent/jobs";

export const runtime = "nodejs";

/** 취소: 리스를 놓아 진행 중 호출은 하트비트가 멈춘다. 이미 이력서를 저장했으면 409, 남의 작업이면 404. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const job = await cancelAgentJob(user.id, id.slice(0, 64));
    if (!job) return jsonError(AGENT_JOB_NOT_FOUND, 404);
    return Response.json({ agentJob: job }, { headers: noStore });
  } catch (err) {
    return agentErrorResponse(err, "POST /api/resumes/agent-jobs/[id]/cancel");
  }
}
