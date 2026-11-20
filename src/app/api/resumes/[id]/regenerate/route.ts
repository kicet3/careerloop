import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { assertDraftLimit, draftErrorResponse, noStore, scheduleDraftJob } from "@/lib/resumes/draft-http";
import { startResumeDraftJob } from "@/lib/resumes/draft-jobs";
import { parseJsonInput, readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { findActiveRegenerate, RegenerateBusyError, regenerateInputFor, regenerateJobHref, regenerateLabel } from "@/lib/resumes/regenerate";
import { getResumeMeta } from "@/lib/resumes/service";
import { CreateResumeInputSchema, RegenerateResumeInputSchema, type RegenerateResumeResponse } from "@/lib/resumes/types";
import { agentErrorResponse, scheduleAgentAdvance } from "@/lib/resume-agent/http";
import { agentAvailableFor, startResumeAgentJob } from "@/lib/resume-agent/jobs";

export const runtime = "nodejs";
// after()로 이어지는 실행의 시간 상한(POST /api/resumes와 같다 — 초안·에이전트 작업이 이 값에 맞춰 스스로 멈춘다). 리터럴이어야 한다.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

function busyResponse(err: RegenerateBusyError): Response {
  return Response.json({ error: err.message, code: "regenerating", jobHref: regenerateJobHref(err.job) }, { status: 409, headers: noStore });
}

/**
 * 이미 만든 이력서 다시 생성(202): 결과는 이 이력서의 새 버전(source 'ai')으로 저장된다 — 새 이력서를 만들지 않는다.
 * mode 'agent'(기본, 쓸 수 있을 때) → 에이전트 작업, 'single' 또는 에이전트를 쓸 수 없으면 빠른 초안 작업(modeFallback 'agent_unavailable').
 * 동시 작업 수(빠른 초안은 하루 한도도)는 새로 만들기와 같이 센다. 에이전트는 하루 한도가 없다. 같은 이력서를 다시 생성 중이면 409(code 'regenerating'), 남의·없는 이력서는 404.
 */
export async function POST(req: Request, { params }: Ctx) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const meta = await getResumeMeta(user.id, id.slice(0, 64));
    if (!meta) return resumeNotFound();
    const body = await readJsonInput(req, RegenerateResumeInputSchema, 64 * 1024);
    // 한도를 세기 전에 알린다(작업 시작 트랜잭션이 잠금 안에서 한 번 더 확인한다).
    const running = await findActiveRegenerate(user.id, meta.id);
    if (running) return busyResponse(new RegenerateBusyError(running));
    const regenerate = { resumeId: meta.id, label: regenerateLabel(meta) };

    let modeFallback: RegenerateResumeResponse["modeFallback"];
    if (body.mode !== "single") {
      if (await agentAvailableFor(user)) {
        try {
          // 작업이 저장된 입력을 같은 스키마로 다시 읽으므로 여기서 먼저 검증한다(회사·직무가 빈 예전 이력서 등은 400).
          const input = parseJsonInput(CreateResumeInputSchema, regenerateInputFor(meta, body, "agent"));
          const { job, runId } = await startResumeAgentJob(user, input, { regenerate });
          scheduleAgentAdvance(job.id, { startedAt, userId: user.id, runId });
          const res: RegenerateResumeResponse = { mode: "agent", jobId: job.id, href: regenerateJobHref({ mode: "agent", id: job.id }) };
          return Response.json({ ...res, agentJob: job }, { status: 202, headers: noStore });
        } catch (err) {
          if (err instanceof RegenerateBusyError) return busyResponse(err);
          return agentErrorResponse(err, "POST /api/resumes/[id]/regenerate (agent)");
        }
      }
      if (body.mode === "agent") modeFallback = "agent_unavailable";
    }
    const input = parseJsonInput(CreateResumeInputSchema, regenerateInputFor(meta, body, "single"));
    const { job, runId, provider } = await startResumeDraftJob(user, input, { beforeCreate: () => assertDraftLimit(user.id), regenerate });
    scheduleDraftJob(user.id, job.id, runId, provider);
    const res: RegenerateResumeResponse = { mode: "single", jobId: job.id, href: regenerateJobHref({ mode: "single", id: job.id }), ...(modeFallback ? { modeFallback } : {}) };
    return Response.json({ ...res, draftJob: job }, { status: 202, headers: noStore });
  } catch (err) {
    if (err instanceof RegenerateBusyError) return busyResponse(err);
    return draftErrorResponse(err, "POST /api/resumes/[id]/regenerate");
  }
}
