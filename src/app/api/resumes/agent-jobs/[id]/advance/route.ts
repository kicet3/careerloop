import { jsonError } from "@/lib/diagnoses/http";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { agentErrorResponse, noStore, scheduleAgentAdvance } from "@/lib/resume-agent/http";
import { AGENT_JOB_NOT_FOUND, canAdvance, getAgentJob } from "@/lib/resume-agent/jobs";

export const runtime = "nodejs";
// after()로 이어지는 단계 실행의 시간 상한(resume-agent/jobs.ts AGENT_ROUTE_MAX_DURATION_SEC와 같다). Next가 정적으로 읽으므로 리터럴.
export const maxDuration = 300;

/**
 * 진행 화면의 이어 가기(연쇄가 막힌 배포의 안전망). 리스가 비어 있을 때만 after()에서 이어서 실행한다 — 반복해 불러도 LLM 호출은
 * 늘지 않는다(리스를 못 잡으면 no-op). 레이트 리밋은 없고, 실제로 단계를 시작한 호출만 연쇄 횟수 상한에 센다. 남의 작업이면 404.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const jobId = id.slice(0, 64);
    const state = await canAdvance(user.id, jobId);
    if (state === "missing") return jsonError(AGENT_JOB_NOT_FOUND, 404);
    if (state === "ok") scheduleAgentAdvance(jobId, { startedAt, userId: user.id });
    const job = await getAgentJob(user.id, jobId);
    return Response.json({ agentJob: job, scheduled: state === "ok" }, { status: 202, headers: noStore });
  } catch (err) {
    return agentErrorResponse(err, "POST /api/resumes/agent-jobs/[id]/advance");
  }
}
