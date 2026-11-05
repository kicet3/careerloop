import "server-only";
/**
 * 공고 라우트 공용: 오류 응답(중복 공고는 기존 id를 함께), 404, 요청 제한.
 */
import { featureErrorResponse } from "@/lib/api/errors";
import { createRateLimiter } from "@/lib/auth/rate-limit";
import { jsonError } from "@/lib/diagnoses/http";
import { DuplicatePostingError, POSTING_NOT_FOUND } from "./service";

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
};

/** 공고 추가·수정·삭제: 사용자당 분당 60회(스크립트 남용 방지). 하루 가져오기 횟수는 DB(posting_imports)로 따로 센다. */
export const postingWriteLimiter = (globalForPostings.__postingWriteLimiter ??= createRateLimiter({ limit: 60, windowMs: 60_000 }));

/** URL 가져오기 연타 방지: 사용자당 분당 6회. */
export const postingImportBurstLimiter = (globalForPostings.__postingImportBurstLimiter ??= createRateLimiter({
  limit: 6,
  windowMs: 60_000,
}));

export function tooManyRequests(message: string, retryAfterSec: number): Response {
  return Response.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfterSec), "Cache-Control": "no-store" } });
}
