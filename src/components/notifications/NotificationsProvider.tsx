"use client";
/**
 * 앱 레이아웃이 서버에서 센 읽지 않은 알림 수를 알림 버튼에 넘긴다. 첫 목록 요청(./store.ts)이 끝나기 전(서버 렌더·하이드레이션 포함)
 * 배지는 이 값을 쓰고, 목록을 받았거나 화면에서 읽음 처리를 한 뒤에는 저장소 값을 쓴다(NotificationBell의 bellUnreadCount). 레이아웃은 화면 이동으로 다시 그려지지 않으므로 이 값은 앱 틀을
 * 불러온 시점(새로고침)의 수다. null이면 모른다(배지 없음).
 * 앱 틀이 그려져 있는 동안 알림 실시간 수신(Supabase Realtime, 설정됐을 때만 — ./realtime.ts)을 연결한다. 탭 하나에 하나.
 */
import { createContext, useContext, useEffect } from "react";
import { acquireNotificationRealtime } from "./realtime";
import { pollNotificationsLive } from "./store";

const InitialUnreadContext = createContext<number | null>(null);

export function NotificationsProvider({ initialUnread, children }: { initialUnread: number | null; children: React.ReactNode }) {
  useEffect(() => acquireNotificationRealtime({ onNotification: () => void pollNotificationsLive() }), []);
  return <InitialUnreadContext.Provider value={initialUnread}>{children}</InitialUnreadContext.Provider>;
}

export function useInitialUnread(): number | null {
  return useContext(InitialUnreadContext);
}
