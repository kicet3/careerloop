/**
 * ADMIN_EMAILS(쉼표·공백 구분 이메일 목록) 규칙. 순수 — 테스트를 위해 env를 인자로 받는다.
 * 목록의 이메일로 로그인하면(세션 확인 때마다 검사) role=admin·status=approved로 올린다(src/lib/auth/session.ts).
 * 목록에서 빼도 이미 admin인 계정을 자동으로 내리지는 않는다(DB에서 직접 바꾼다).
 */
type Env = Record<string, string | undefined>;

export function adminEmails(env: Env = process.env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@")),
  );
}

export function isAdminEmail(email: string | null | undefined, env: Env = process.env): boolean {
  if (!email) return false;
  return adminEmails(env).has(email.trim().toLowerCase());
}

/** 승인자 기록(users.approved_by)에 쓰는 시스템 표식. */
export const APPROVED_BY_ADMIN_EMAILS = "system:admin_emails";
