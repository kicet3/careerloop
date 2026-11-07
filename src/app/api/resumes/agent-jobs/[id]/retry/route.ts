import { jsonError } from "@/lib/diagnoses/http";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { assertDraftLimit, scheduleDraftJob } from "@/lib/resumes/draft-http";
import { startResumeDraftJob } from "@/lib/resumes/draft-jobs";
import { agentErrorResponse, assertAgentLimit, noStore, scheduleAgentAdvance } from "@/lib/resume-agent/http";
import { AGENT_JOB_NOT_FOUND, agentJobFallback, closeForFallback, retryAgentJob } from "@/lib/resume-agent/jobs";

export const runtime = "nodejs";
// after()로 이어지는 실행의 시간 상한(POST /api/resumes와 같다). 리터럴이어야 한다.
export const maxDuration = 300;

/**
 * 다시 시도(202): 실패한 단계부터(끝난 단계는 건너뜀, 레이트 리밋 1회). ?from=jd면 처음부터.
 * ?mode=single이면 같은 입력으로 빠른 초안(단일 초안 작업, 다시 생성이면 같은 대상)을 시작하고 이 작업을 취소로 닫는다(에이전트 한도는 세지 않고 초안 한도를 센다).
 * 진행 중·완성이면 409, 남의 작업이면 404.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const url = new URL(req.url);
  try {
    const jobId = id.slice(0, 64);
    if (url.searchParams.get("mode") === "single") {
      const fallback = await agentJobFallback(user.id, jobId);
      if (!fallback) return jsonError(AGENT_JOB_NOT_FOUND, 404);
      // 다시 생성 작업이면 빠른 초안도 같은 이력서의 새 버전을 저장한다(새 이력서를 만들지 않는다).
      const { job, runId, provider } = await startResumeDraftJob(
        user,
        { ...fallback.input, mode: "single" },
        { beforeCreate: () => assertDraftLimit(user.id), ...(fallback.regenerate ? { regenerate: fallback.regenerate } : {}) },
      );
      await closeForFallback(user.id, jobId);
      scheduleDraftJob(user.id, job.id, runId, provider);
      return Response.json({ draftJob: job }, { status: 202, headers: noStore });
    }
    const from = url.searchParams.get("from") === "jd" ? "jd" : null;
    const started = await retryAgentJob(user.id, jobId, { from, beforeRestart: () => assertAgentLimit(user.id) });
    if (!started) return jsonError(AGENT_JOB_NOT_FOUND, 404);
    scheduleAgentAdvance(started.job.id, { startedAt, userId: user.id, runId: started.runId });
    return Response.json({ agentJob: started.job }, { status: 202, headers: noStore });
  } catch (err) {
    return agentErrorResponse(err, "POST /api/resumes/agent-jobs/[id]/retry");
  }
}
