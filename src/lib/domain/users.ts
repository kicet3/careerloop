/**
 * 회원 역할·승인 상태(클라이언트·서버 공용). 저장은 users.role·users.status(text, prisma/schema.prisma).
 * - pending: Google로 새로 가입 — 로그인은 되지만 '관리자 승인 대기' 화면만 본다.
 * - approved: 앱 사용 가능. 기존 회원은 마이그레이션(20261107000000)으로 approved.
 * - rejected / suspended: 로그인은 되지만 안내 화면만 본다(정지할 때 세션을 모두 지운다).
 */
export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  pending: "승인 대기",
  approved: "승인됨",
  rejected: "거절",
  suspended: "정지",
};

/** 회원 관리 화면의 탭. 'blocked'는 거절·정지를 함께 보여 준다. */
export const ADMIN_USER_TABS = ["pending", "approved", "blocked"] as const;
export type AdminUserTab = (typeof ADMIN_USER_TABS)[number];
export const ADMIN_USER_TAB_LABELS: Record<AdminUserTab, string> = {
  pending: "승인 대기",
  approved: "승인됨",
  blocked: "거절·정지",
};
export const ADMIN_USER_TAB_STATUSES: Record<AdminUserTab, readonly UserStatus[]> = {
  pending: ["pending"],
  approved: ["approved"],
  blocked: ["rejected", "suspended"],
};

/** 관리자가 회원에게 할 수 있는 동작 → 바뀌는 상태. */
export const ADMIN_USER_ACTIONS = ["approve", "reject", "suspend", "unsuspend"] as const;
export type AdminUserAction = (typeof ADMIN_USER_ACTIONS)[number];
export const ADMIN_USER_ACTION_TARGET: Record<AdminUserAction, UserStatus> = {
  approve: "approved",
  reject: "rejected",
  suspend: "suspended",
  unsuspend: "approved",
};
export const ADMIN_USER_ACTION_LABELS: Record<AdminUserAction, string> = {
  approve: "승인",
  reject: "거절",
  suspend: "정지",
  unsuspend: "정지 해제",
};

/** 지금 상태에서 허용하는 동작. 같은 상태로 바꾸는 동작은 넣지 않는다. */
export function allowedAdminActions(status: UserStatus): AdminUserAction[] {
  switch (status) {
    case "pending":
      return ["approve", "reject"];
    case "approved":
      return ["suspend"];
    case "rejected":
      return ["approve"];
    case "suspended":
      return ["unsuspend"];
  }
}

export function isUserStatus(v: unknown): v is UserStatus {
  return typeof v === "string" && (USER_STATUSES as readonly string[]).includes(v);
}

export function isUserRole(v: unknown): v is UserRole {
  return typeof v === "string" && (USER_ROLES as readonly string[]).includes(v);
}

/** 회원 탈퇴 확인 문구(화면에서 직접 입력, DELETE /api/account 본문 confirm). */
export const ACCOUNT_DELETE_CONFIRM = "탈퇴합니다";
