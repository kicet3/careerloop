import "server-only";
/**
 * 공고 라우트 공용: 오류 응답(중복 공고는 기존 id를 함께), 404, 요청 제한, AI 추출 오류의 사용자용 문구.
 */
import { FeatureError, featureErrorResponse } from "@/lib/api/errors";
import { createRateLimiter } from "@/lib/auth/rate-limit";
import { jsonError } from "@/lib/diagnoses/http";
import { LlmPermanentError } from "@/lib/llm";
import { ProviderServiceError } from "@/lib/providers/errors";
import { PostingExtractError } from "./extract";
import { PostingFetchError } from "./fetch";
import { DuplicatePostingError, POSTING_NOT_FOUND } from "./service";
import { PostingUrlError } from "./url";

/** 공고 본문(JD 30,000자) + 메모 여유분. */
export const MAX_POSTING_BODY_BYTES = 256 * 1024;

export const postingNotFound = () => jsonError(POSTING_NOT_FOUND, 404);

/** 중복 공고(409)는 { error, existingId }로, 나머지는 featureErrorResponse. */
export function postingErrorResponse(err: unknown, context: string): Response {
  if (err instanceof DuplicatePostingError) {
    return Response.json({ error: err.message, existingId: err.existingId }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  return featureErrorResponse(err, context);
}

const globalForPostings = globalThis as unknown as {
  __postingWriteLimiter?: ReturnType<typeof createRateLimiter>;
  __postingImportBurstLimiter?: ReturnType<typeof createRateLimiter>;
  __postingStructureDailyLimiter?: ReturnType<typeof createRateLimiter>;
};

/** 공고 추가·수정·삭제: 사용자당 분당 60회(스크립트 남용 방지). 하루 가져오기 횟수는 DB(posting_imports)로 따로 센다. */
export const postingWriteLimiter = (globalForPostings.__postingWriteLimiter ??= createRateLimiter({ limit: 60, windowMs: 60_000 }));

/** URL 가져오기 연타 방지: 사용자당 분당 6회. */
export const postingImportBurstLimiter = (globalForPostings.__postingImportBurstLimiter ??= createRateLimiter({
  limit: 6,
  windowMs: 60_000,
}));

/** 'AI로 다시 정리'(구역 재추출): 사용자당 하루 20회. 가져오기 하루 횟수(posting_imports)와 따로 센다(메모리 — 인스턴스마다). */
export const DAILY_POSTING_STRUCTURE_LIMIT = 20;
export const postingStructureDailyLimiter = (globalForPostings.__postingStructureDailyLimiter ??= createRateLimiter({
  limit: DAILY_POSTING_STRUCTURE_LIMIT,
  windowMs: 86_400_000,
}));

export const POSTING_AI_GENERIC_ERROR = "공고를 가져오지 못했습니다. 링크와 AI 연결 상태를 확인한 뒤 다시 시도하세요.";
export const POSTING_AI_TIMEOUT_ERROR = "공고 분석 시간이 초과됐습니다. 잠시 후 다시 시도하세요.";

const LLM_ERROR_MESSAGES: Partial<Record<LlmPermanentError["reason"], string>> = {
  refusal: "AI 모델이 이 공고 분석을 거절했습니다. 직접 입력으로 추가해 주세요.",
  invalid_output: "AI 분석 결과 형식을 확인하지 못했습니다. 다시 시도하세요.",
  auth: "AI 계정 로그인이 없거나 만료되었습니다. 'AI 연결' 화면에서 다시 로그인한 뒤 재시도해 주세요.",
  usage_limit: "연결된 AI 계정의 사용량 한도에 걸렸습니다. 한도가 풀린 뒤 다시 시도해 주세요.",
  unavailable: "지금 쓸 수 있는 AI 엔진이 없습니다. 'AI 연결' 화면을 확인해 주세요.",
  timeout: POSTING_AI_TIMEOUT_ERROR,
};

/**
 * 공고 AI 추출(가져오기·다시 정리) 오류 → 사용자에게 보여도 되는 문구. 그 밖의 오류(네트워크 원문·내부 주소 등)는
 * 로그에만 남기고 일반 문구로 바꾼다.
 */
export function safePostingAiError(err: unknown, opts: { timedOut?: boolean; context?: string; fallback?: string } = {}): string {
  if (opts.timedOut) return POSTING_AI_TIMEOUT_ERROR;
  if (err instanceof PostingFetchError || err instanceof PostingExtractError || err instanceof PostingUrlError) return err.message;
  if (err instanceof FeatureError || err instanceof ProviderServiceError) return err.message;
  const fallback = opts.fallback ?? POSTING_AI_GENERIC_ERROR;
  if (err instanceof LlmPermanentError) return LLM_ERROR_MESSAGES[err.reason] ?? fallback;
  console.error(`[${opts.context ?? "posting-ai"}]`, err);
  return fallback;
}

export function tooManyRequests(message: string, retryAfterSec: number): Response {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfterSec), "Cache-Control": "no-store" } });
}
