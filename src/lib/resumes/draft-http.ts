import "server-only";
/**
 * AI 이력서 초안 작업 라우트 공용: 레이트 리밋(429 + Retry-After), 백그라운드 실행 예약, 오류 응답.
 */
import { FeatureError, featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, RESUME_DRAFT_LIMIT } from "@/lib/auth/db-rate-limit";
import type { ProviderId } from "@/lib/domain/providers";
import { dispatchJob, type DispatchDeps } from "@/lib/worker/dispatch";
import { runResumeDraftJob } from "./draft-jobs";

export const noStore = { "Cache-Control": "no-store" } as const;

export class DraftRateLimitError extends FeatureError {
  constructor(readonly retryAfterSec: number) {
    super("오늘 만들 수 있는 AI 초안 수를 넘었습니다. 빈 문서로 시작하거나 내일 다시 시도해 주세요.", 429);
    this.name = "DraftRateLimitError";
  }
}

/** AI 초안: 사용자당 24시간 30회(시작·다시 시도 모두 센다). DB 원장이라 인스턴스 사이에 공유된다. */
export async function assertDraftLimit(userId: string): Promise<void> {
  const limit = await hitDbLimit(RESUME_DRAFT_LIMIT, userId);
  if (!limit.ok) throw new DraftRateLimitError(limit.retryAfterSec);
}

export function draftErrorResponse(err: unknown, context: string): Response {
  if (err instanceof DraftRateLimitError) {
    return Response.json({ error: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfterSec), ...noStore } });
  }
  return featureErrorResponse(err, context);
}

/**
 * 응답 뒤 초안을 쓴다(라우트 핸들러 안에서만). 워커 스위치(WORKER_JOBS에 'resume-draft')가 켜져 있고 엔진이 'anthropic'이면
 * Python 워커로 넘기고(docs/PYTHON-WORKER.md §3.1), 꺼져 있거나 워커가 202로 받지 않으면 지금처럼 after()에서 실행한다
 * (실행 시간은 라우트 maxDuration(300초)을 따른다). 워커에는 작업 id·runId만 보낸다 — 워커는 user_id를 작업 행에서 다시 읽는다.
 * 둘이 함께 시작해도 'material' → 'writing' 선점(runResumeDraftJob)으로 한쪽만 실행한다.
 */
export function scheduleDraftJob(userId: string, jobId: string, runId: string, provider: ProviderId, deps?: DispatchDeps): void {
  dispatchJob("resume-draft", { id: jobId, runId, provider }, () => runResumeDraftJob(userId, jobId, runId, provider), deps);
}
