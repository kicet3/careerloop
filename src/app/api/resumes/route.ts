import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { createResumeFromInput } from "@/lib/resumes/create";
import { assertDraftLimit, draftErrorResponse, noStore, scheduleDraftJob } from "@/lib/resumes/draft-http";
import { startResumeDraftJob } from "@/lib/resumes/draft-jobs";
import type { StartResumeDraftResponse } from "@/lib/resumes/draft-job-types";
import { jsonError } from "@/lib/diagnoses/http";
import { withResumePostingDefaults } from "@/lib/postings/defaults";
import { getPosting, POSTING_NOT_FOUND } from "@/lib/postings/service";
import { parseJsonInput, readJsonBody } from "@/lib/resumes/http";
import { listResumes, parseResumeStatusFilter } from "@/lib/resumes/service";
import { CreateResumeInputSchema, type CreateResumeResponse } from "@/lib/resumes/types";
import { agentErrorResponse, scheduleAgentAdvance } from "@/lib/resume-agent/http";
import { agentAvailableFor, startResumeAgentJob } from "@/lib/resume-agent/jobs";
import type { StartResumeAgentResponse } from "@/lib/resume-agent/job-types";

export const runtime = "nodejs";
// after()로 이어지는 AI 초안(LLM 1회)의 시간 상한. Vercel에서는 초안 작업이 maxDuration - 30초에 스스로 멈추고 실패로 기록한다
// (draft-jobs.ts DRAFT_ROUTE_MAX_DURATION_SEC와 같아야 한다). Next가 정적으로 읽으므로 리터럴이어야 한다.
export const maxDuration = 300;

/** 목록. ?status=all|draft|applying|submitted|general(모르는 값은 all). */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const status = parseResumeStatusFilter(new URL(req.url).searchParams.get("status"));
    return Response.json({ items: await listResumes(user.id, { status }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes");
  }
}

/**
 * 새 이력서: 출처가 그래프이고 에이전트를 쓸 수 있으면(mode 'agent' 또는 비움) 그래프 이력서 에이전트 작업을 만들고 202 { agentJob }
 * (진행 화면 /app/resumes/agent/[id]). mode 'agent'인데 쓸 수 없으면(플래그 꺼짐·그래프 비어 있음) 빠른 초안으로 만들고 modeFallback: 'agent_unavailable'.
 * 그 밖에 출처가 그래프·진단이면 AI 초안 작업을 만들고 202 { draftJob }(초안은 응답 뒤 백그라운드에서 쓴다 — 화면은
 * /app/resumes/drafts/[id]에서 폴링), 빈 문서면 바로 v1(201 { id }), sourceResumeId면 그 이력서 내용을 복사(AI 없음, 201).
 * kind 'general'은 공용 이력서(회사·공고 없음).
 * postingId(보관 공고)를 주면 내 공고인지 확인하고, 비운 회사·직무·JD를 공고 값으로 채운 뒤 이력서를 공고에 연결한다.
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  try {
    let raw = await readJsonBody(req);
    const body = raw as { postingId?: unknown; kind?: unknown } | null;
    const postingId = body?.postingId;
    // 공용 이력서는 공고에 연결하지 않는다(보낸 postingId는 무시).
    if (body?.kind !== "general" && typeof postingId === "string" && postingId.trim()) {
      const posting = await getPosting(user.id, postingId.trim().slice(0, 64));
      if (!posting) return jsonError(POSTING_NOT_FOUND, 404);
      raw = withResumePostingDefaults(raw, posting);
    }
    const input = parseJsonInput(CreateResumeInputSchema, raw);
    let modeFallback: "agent_unavailable" | undefined;
    if (input.source.kind === "graph" && !input.sourceResumeId && input.mode !== "single") {
      if (await agentAvailableFor(user)) {
        try {
          const { job, runId } = await startResumeAgentJob(user, input);
          scheduleAgentAdvance(job.id, { startedAt, userId: user.id, runId });
          return Response.json({ agentJob: job } satisfies StartResumeAgentResponse, { status: 202, headers: noStore });
        } catch (err) {
          return agentErrorResponse(err, "POST /api/resumes (agent)");
        }
      }
      if (input.mode === "agent") modeFallback = "agent_unavailable";
    }
    if (input.source.kind !== "blank" && !input.sourceResumeId) {
      // AI 초안: 입력·자료·엔진 확인 뒤 레이트 리밋(사용자당 24시간 30회)을 세고 작업 행을 만든다.
      const { job, runId, provider } = await startResumeDraftJob(user, input, { beforeCreate: () => assertDraftLimit(user.id) });
      scheduleDraftJob(user.id, job.id, runId, provider);
      return Response.json({ draftJob: job, ...(modeFallback ? { modeFallback } : {}) } satisfies StartResumeDraftResponse, { status: 202, headers: noStore });
    }
    const created = await createResumeFromInput(user, input);
    return Response.json(created satisfies CreateResumeResponse, { status: 201 });
  } catch (err) {
    return draftErrorResponse(err, "POST /api/resumes");
  }
}
