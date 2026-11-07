import "server-only";
/**
 * 에이전트 라우트 공용: 레이트 리밋(429 + Retry-After), 동시 작업(409 + 기존 작업 id), 백그라운드 이어 가기 예약.
 * after() 콜백 안에서는 요청 객체를 읽지 않는다 — 마감 시각은 라우트 첫 줄에서 계산해 넘긴다.
 */
import { after } from "next/server";
import { FeatureError, featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, RESUME_AGENT_LIMIT } from "@/lib/auth/db-rate-limit";
import { advanceAgentJob, agentDeadline, AgentBusyError } from "./jobs";

export const noStore = { "Cache-Control": "no-store" } as const;

export class AgentRateLimitError extends FeatureError {
  constructor(readonly retryAfterSec: number) {
    super("오늘 에이전트 작성 5회를 모두 썼습니다. 빠른 초안으로 만들거나 내일 다시 시도해 주세요.", 429);
    this.name = "AgentRateLimitError";
  }
}

/** 시작·사용자 재시도: 사용자당 24시간 5회. */
export async function assertAgentLimit(userId: string): Promise<void> {
  const limit = await hitDbLimit(RESUME_AGENT_LIMIT, userId);
  if (!limit.ok) throw new AgentRateLimitError(limit.retryAfterSec);
}

export function agentErrorResponse(err: unknown, context: string): Response {
  if (err instanceof AgentRateLimitError) {
    return Response.json({ error: err.message, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(err.retryAfterSec), ...noStore } });
  }
  if (err instanceof AgentBusyError) {
    return Response.json({ error: err.message, code: "busy", agentJobId: err.jobId }, { status: 409, headers: noStore });
  }
  return featureErrorResponse(err, context);
}

/** 응답 뒤 이어서 실행한다(라우트 핸들러 안에서만). startedAt은 요청 시작 시각(after도 같은 시간 안에서 돈다). */
export function scheduleAgentAdvance(jobId: string, opts: { startedAt: number; userId?: string; runId?: string }): void {
  const deadlineAt = agentDeadline(opts.startedAt);
  after(() => advanceAgentJob(jobId, { userId: opts.userId, runId: opts.runId, deadlineAt }));
}
