/**
 * 앱 안 알림(상단 알림 버튼) 타입·상수(클라이언트·서버 공용, 순수). 저장·생성은 src/lib/notifications/service.ts.
 */

export const NOTIFICATION_KINDS = [
  "resume-draft-completed",
  "resume-draft-failed",
  "diagnosis-completed",
  "diagnosis-failed",
  "posting-import-completed",
  "posting-import-failed",
  "interview-ready",
  "interview-failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** 사용자당 남기는 알림 수(새 알림을 만들 때 오래된 것부터 지운다). */
export const MAX_NOTIFICATIONS_PER_USER = 100;
/** 목록 API가 한 번에 돌려주는 수. */
export const NOTIFICATION_LIST_LIMIT = 30;
/** 제목·본문 길이 상한. */
export const MAX_NOTIFICATION_TITLE_CHARS = 120;
export const MAX_NOTIFICATION_BODY_CHARS = 300;

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** 앱 안 경로(/app/...) 또는 null. */
  link: string | null;
  readAt: number | null;
  createdAt: number;
}

/** GET /api/notifications 응답. */
export interface NotificationListResponse {
  items: NotificationItem[];
  unreadCount: number;
}

/** 실패 알림인가(아이콘·색 구분). */
export function isFailureNotification(kind: NotificationKind): boolean {
  return kind.endsWith("-failed");
}

/** 앱 안 경로만 링크로 쓴다(외부 주소·스킴 상대 주소 차단). 아니면 null. */
export function safeNotificationLink(raw: string | null | undefined): string | null {
  const s = raw?.trim() ?? "";
  if (!s.startsWith("/app") || s.startsWith("//") || /[\s\\]/.test(s)) return null;
  if (s !== "/app" && !s.startsWith("/app/") && !s.startsWith("/app?")) return null;
  return s.slice(0, 300);
}

/** "방금 전", "3분 전", "2시간 전", "5일 전", 그보다 오래면 "2026. 11. 7." */
export function timeAgo(at: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return "방금 전";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(at).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
}
