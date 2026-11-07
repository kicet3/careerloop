import "server-only";
/**
 * 경험 그래프 포트폴리오 작업 라우트 공용: 레이트 리밋(429 + Retry-After), 백그라운드 실행 예약, 오류 응답.
 */
import { after } from "next/server";
import { FeatureError, featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, PORTFOLIO_DRAFT_LIMIT } from "@/lib/auth/db-rate-limit";
import type { ProviderId } from "@/lib/domain/providers";
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

/** 응답 뒤 포트폴리오를 쓴다(라우트 핸들러 안에서만). 실행 시간은 라우트 maxDuration(300초)을 따른다. */
export function scheduleGraphPortfolioJob(userId: string, jobId: string, runId: string, provider: ProviderId): void {
  after(() => runGraphPortfolioJob(userId, jobId, runId, provider));
}
