import "server-only";
/**
 * 경험 그래프 포트폴리오 작업 라우트 공용: 레이트 리밋(429 + Retry-After), 백그라운드 실행 예약, 오류 응답.
 */
import { FeatureError, featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, PORTFOLIO_DRAFT_LIMIT } from "@/lib/auth/db-rate-limit";
import type { ProviderId } from "@/lib/domain/providers";
import { dispatchJob, type DispatchDeps } from "@/lib/worker/dispatch";
import { runGraphPortfolioJob } from "./graph-jobs";

export const noStore = { "Cache-Control": "no-store" } as const;

export class GraphPortfolioRateLimitError extends FeatureError {
  constructor(readonly retryAfterSec: number) {
    super("오늘 만들 수 있는 포트폴리오 수를 넘었습니다. 내일 다시 시도해 주세요.", 429);
    this.name = "GraphPortfolioRateLimitError";
  }
}

/** 사용자당 24시간 PORTFOLIO_DRAFT_LIMIT회(시작·다시 만들기·다시 시도 모두 센다). */
export async function assertGraphPortfolioLimit(userId: string): Promise<void> {
  const limit = await hitDbLimit(PORTFOLIO_DRAFT_LIMIT, userId);
  if (!limit.ok) throw new GraphPortfolioRateLimitError(limit.retryAfterSec);
}

export function graphPortfolioErrorResponse(err: unknown, context: string): Response {
  if (err instanceof GraphPortfolioRateLimitError) {
    return Response.json({ error: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfterSec), ...noStore } });
  }
  return featureErrorResponse(err, context);
}

/**
 * 응답 뒤 포트폴리오를 쓴다(라우트 핸들러 안에서만). WORKER_JOBS에 'portfolio-graph'가 켜져 있고 엔진이 'anthropic'이면
 * Python 워커로 넘기고(docs/PYTHON-WORKER.md §3.1), 꺼져 있거나 워커가 202로 받지 않으면 지금처럼 Vercel에서 실행한다
 * (실행 시간은 라우트 maxDuration(300초)을 따른다). 워커에는 작업 id·runId만 보낸다 — 워커는 user_id를 작업 행에서 다시 읽는다.
 * 두 쪽이 함께 실행되지 않는 것은 runGraphPortfolioJob·워커가 같은 조건부 claim(claimGraphPortfolioRun)으로 시작하기 때문이다.
 */
export function scheduleGraphPortfolioJob(userId: string, jobId: string, runId: string, provider: ProviderId, deps?: DispatchDeps): void {
  dispatchJob("portfolio-graph", { id: jobId, runId, provider }, () => runGraphPortfolioJob(userId, jobId, runId, provider), deps);
}
