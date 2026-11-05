/**
 * 앱 사용 가능 여부 판정(순수). 세션 확인 뒤 src/lib/auth/session.ts의 가드가 쓴다.
 * 순서: 거절·정지 → 안내 화면 / 필수 동의(현재 버전) 없음 → 동의 화면 / 승인 대기 → 대기 화면 / 승인됨 → 통과.
 */
import type { ConsentType } from "@/lib/legal/consents";
import type { UserStatus } from "@/lib/domain/users";

export type AccessDecision = "ok" | "consent" | "pending" | "rejected" | "suspended";

export function accessDecision(status: UserStatus, missingConsents: readonly ConsentType[]): AccessDecision {
  if (status === "rejected" || status === "suspended") return status;
  if (missingConsents.length > 0) return "consent";
  if (status === "pending") return "pending";
  return "ok";
}

/** 비승인 사용자가 볼 화면(로그인은 됐다). */
export const CONSENT_PATH = "/consent";
export const PENDING_PATH = "/pending";

/** 판정 → 이동할 화면(ok면 null). */
export function accessRedirectPath(decision: AccessDecision, next?: string | null): string | null {
  if (decision === "ok") return null;
  if (decision === "consent") return next ? `${CONSENT_PATH}?next=${encodeURIComponent(next)}` : CONSENT_PATH;
  return PENDING_PATH;
}

/** API 403 응답 코드와 문구. 화면은 code로 동의·대기 화면으로 안내한다. */
export const ACCESS_API_ERRORS: Record<Exclude<AccessDecision, "ok">, { code: string; error: string }> = {
  consent: { code: "consent_required", error: "약관·개인정보 안내 확인이 필요합니다." },
  pending: { code: "approval_pending", error: "관리자 승인 후 이용할 수 있습니다." },
  rejected: { code: "account_rejected", error: "가입이 승인되지 않은 계정입니다." },
  suspended: { code: "account_suspended", error: "이용이 정지된 계정입니다." },
};
