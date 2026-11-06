import { AppSidebar } from "@/components/app/AppSidebar";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { NotificationToasts } from "@/components/notifications/NotificationToasts";
import { NotificationsProvider } from "@/components/notifications/NotificationsProvider";
import { countPendingUsers } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { appEnv } from "@/lib/config/env";
import { countUnreadNotifications } from "@/lib/notifications/service";
import { cliProvidersEnabled } from "@/lib/providers/cli";

/**
 * 앱 화면 틀: 넓은 화면(lg 이상)은 왼쪽 고정 사이드바 + 본문 위 얇은 상단 바(알림 버튼) + 본문 전체 폭,
 * 좁은 화면은 상단 얇은 바(메뉴·로고·알림 버튼) + 서랍 메뉴. 새 알림 토스트는 화면 오른쪽 아래에 하나만 그린다.
 * 알림 배지의 첫 값(읽지 않은 수)은 여기서 센다 — 새로고침하면 서버 값으로 맞는다(Supabase Realtime이 설정돼 있으면 새 알림은 바로 받는다).
 * 본문 폭은 제한하지 않는다 — 각 화면이 그리드로 넓은 화면을 나눠 쓴다.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // 로그인·승인·필수 동의를 확인한다(아니면 /login·/consent·/pending). 각 화면도 같은 가드를 다시 부른다(요청당 1회 조회).
  const user = await requireUser("/app");
  const isAdmin = user.role === "admin";
  const [pendingCount, initialUnread] = await Promise.all([
    isAdmin ? countPendingUsers() : 0,
    // 세지 못해도 화면은 그린다(배지는 첫 목록 요청이 맞춘다).
    countUnreadNotifications(user.id).catch(() => null),
  ]);
  return (
    <NotificationsProvider initialUnread={initialUnread}>
      <div className="flex w-full flex-1 flex-col lg:flex-row">
        <AppSidebar
          email={user.email}
          name={user.name}
          showConnections={cliProvidersEnabled()}
          isAdmin={isAdmin}
          pendingCount={pendingCount}
          env={appEnv()}
        />
        <div className="flex w-full min-w-0 flex-1 flex-col">
          {/* 넓은 화면 상단 바. 고정(sticky)하지 않는다 — 편집기 미리보기·보고서 목차가 화면 위쪽에 붙는다. */}
          <header className="hidden h-14 shrink-0 items-center justify-end gap-2 border-b border-slate-200 bg-white px-8 lg:flex print:hidden">
            <NotificationBell />
          </header>
          <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 print:p-0">{children}</main>
        </div>
        <NotificationToasts />
      </div>
    </NotificationsProvider>
  );
}
