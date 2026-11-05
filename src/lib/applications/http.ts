import "server-only";
/**
 * 지원 라우트 공용: 404 응답, 쓰기 요청 제한. 입력 읽기·검증은 이력서 라우트의 readJsonInput을 그대로 쓴다.
 */
import { createRateLimiter } from "@/lib/auth/rate-limit";
import { jsonError } from "@/lib/diagnoses/http";
import { APPLICATION_NOT_FOUND } from "./service";

/** 지원 요청 본문 상한(메모 4000자 + 여유). */
export const MAX_APPLICATION_BODY_BYTES = 32 * 1024;

export const applicationNotFound = () => jsonError(APPLICATION_NOT_FOUND, 404);

const globalForLimits = globalThis as unknown as { __applicationWriteLimiter?: ReturnType<typeof createRateLimiter> };

/** 지원 생성·수정·단계 변경·삭제: 사용자당 10분에 120회(자동화 남용 방지 — 사람 손으로는 닿지 않는 수). */
export const applicationWriteLimiter = (globalForLimits.__applicationWriteLimiter ??= createRateLimiter({
  limit: 120,
  windowMs: 10 * 60_000,
}));

/** 쓰기 제한을 넘었으면 429 응답, 아니면 null. */
export function limitWrite(userId: string): Response | null {
  const hit = applicationWriteLimiter.hit(userId);
  if (hit.ok) return null;
  return Response.json(
    { error: "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요." },
    { status: 429, headers: { "Retry-After": String(hit.retryAfterSec) } },
  );
}
