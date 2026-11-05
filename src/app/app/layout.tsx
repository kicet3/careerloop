import { AppSidebar } from "@/components/app/AppSidebar";
import { countPendingUsers } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { appEnv } from "@/lib/config/env";
import { cliProvidersEnabled } from "@/lib/providers/cli";

/**
 * 앱 화면 틀: 넓은 화면(lg 이상)은 왼쪽 고정 사이드바 + 본문 전체 폭, 좁은 화면은 상단 얇은 바 + 서랍 메뉴.
 * 본문 폭은 제한하지 않는다 — 각 화면이 그리드로 넓은 화면을 나눠 쓴다.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // 로그인·승인·필수 동의를 확인한다(아니면 /login·/consent·/pending). 각 화면도 같은 가드를 다시 부른다(요청당 1회 조회).
  const user = await requireUser("/app");
  const isAdmin = user.role === "admin";
  const pendingCount = isAdmin ? await countPendingUsers() : 0;
  return (
    <div className="flex w-full flex-1 flex-col lg:flex-row">
      <AppSidebar
        email={user.email}
        name={user.name}
        showConnections={cliProvidersEnabled()}
        isAdmin={isAdmin}
        pendingCount={pendingCount}
        env={appEnv()}
      />
      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 print:p-0">{children}</main>
    </div>
  );
}
