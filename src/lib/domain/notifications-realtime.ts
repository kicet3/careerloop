/**
 * 알림 실시간 수신(Supabase Realtime Broadcast) 공용 타입·상수(클라이언트·서버 공용, 순수). 설정 안내는 docs/REALTIME.md.
 *
 * - 서버는 새 알림을 만들 때 비공개 채널 "notifications:<userId>"에 이벤트 "notification", 내용 { id }만 보낸다(알림 내용은 싣지 않는다 —
 *   클라이언트가 GET /api/notifications로 다시 받는다).
 * - 클라이언트는 GET /api/notifications/realtime-token으로 짧은 수명의 JWT를 받아 그 채널만 구독한다(RLS가 자기 topic만 허용).
 */

export const NOTIFICATION_REALTIME_EVENT = "notification";
/** 토큰 수명(초). Realtime은 토큰이 만료되면 연결을 끊으므로 그 전에 새 토큰을 받는다. */
export const NOTIFICATION_REALTIME_TOKEN_TTL_SEC = 60 * 60;
/** 만료 이만큼 전(ms)에 새 토큰을 받는다. */
export const NOTIFICATION_REALTIME_REFRESH_BEFORE_MS = 5 * 60_000;

export function notificationTopic(userId: string): string {
  return `notifications:${userId}`;
}

/** GET /api/notifications/realtime-token 응답(설정이 없으면 404). */
export interface NotificationRealtimeToken {
  url: string;
  anonKey: string;
  token: string;
  topic: string;
  /** 만료 시각(ms). */
  expiresAt: number;
}

/** Broadcast 내용 — 알림 id만. */
export interface NotificationRealtimePayload {
  id: string;
}
