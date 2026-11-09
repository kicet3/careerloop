import "server-only";
/**
 * 면접 연습 라우트 공용: 오류 응답(레이트 리밋은 429 + Retry-After), 404, 백그라운드 작업 예약.
 *
 * 백그라운드 작업은 dispatchJob(src/lib/worker/dispatch.ts)으로 예약한다: WORKER_JOBS에 켜져 있고 엔진이 'anthropic'이면 Python 워커
 * (worker/app/jobs/interview_questions.py·interview_feedback.py)로 보내고, 꺼져 있거나 워커가 202를 주지 않으면 지금처럼 after()에서 실행한다.
 * - interview-questions: id = 세션 id, runId = 세션의 run_id.
 * - interview-feedback: id = runId = 답변 id(답변 행에는 run_id가 없다 — 시작 선점은 claimAnswerRun이 created_at을 시도 표시로 쓴다).
 * 워커는 user_id·엔진을 DB 행에서 다시 읽는다(본문에는 id·runId만 간다).
 */
import { featureErrorResponse } from "@/lib/api/errors";
import { jsonError } from "@/lib/diagnoses/http";
import type { ProviderId } from "@/lib/domain/providers";
import { dispatchJob, type DispatchDeps } from "@/lib/worker/dispatch";
import { InterviewRateLimitError, runInterviewFeedback, runInterviewGeneration } from "./service";
import { INTERVIEW_QUESTION_NOT_FOUND, INTERVIEW_SESSION_NOT_FOUND } from "./store";

/** 요청 본문 상한(답변 3000자 + 여유). */
export const MAX_INTERVIEW_BODY_BYTES = 32 * 1024;

export const sessionNotFound = () => jsonError(INTERVIEW_SESSION_NOT_FOUND, 404);
export const questionNotFound = () => jsonError(INTERVIEW_QUESTION_NOT_FOUND, 404);
export const answerNotFound = () => jsonError("답변을 찾을 수 없습니다.", 404);

export const noStore = { "Cache-Control": "no-store" } as const;

export function interviewErrorResponse(err: unknown, context: string): Response {
  if (err instanceof InterviewRateLimitError) {
    return Response.json(
      { error: err.message },
      { status: 429, headers: { "Retry-After": String(err.retryAfterSec), "Cache-Control": "no-store" } },
    );
  }
  return featureErrorResponse(err, context);
}

/** 응답 뒤 질문을 만든다(라우트 핸들러 안에서만). 워커가 받지 않으면 after()에서 runInterviewGeneration. */
export function scheduleGeneration(userId: string, sessionId: string, runId: string, provider: ProviderId, deps?: DispatchDeps): void {
  dispatchJob("interview-questions", { id: sessionId, runId, provider }, () => runInterviewGeneration(userId, sessionId, runId, provider), deps);
}

/** 응답 뒤 피드백을 만든다(라우트 핸들러 안에서만). 워커가 받지 않으면 after()에서 runInterviewFeedback. */
export function scheduleFeedback(userId: string, answerId: string, provider: ProviderId, deps?: DispatchDeps): void {
  dispatchJob("interview-feedback", { id: answerId, runId: answerId, provider }, () => runInterviewFeedback(userId, answerId, provider), deps);
}
