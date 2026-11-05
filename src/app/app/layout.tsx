import { AppSidebar } from "@/components/app/AppSidebar";
import { requireUser } from "@/lib/auth/session";
import { appEnv } from "@/lib/config/env";
import { cliProvidersEnabled } from "@/lib/providers/cli";

/**
 * 앱 화면 틀: 넓은 화면(lg 이상)은 왼쪽 고정 사이드바 + 본문 전체 폭, 좁은 화면은 상단 얇은 바 + 서랍 메뉴.
 * 본문 폭은 제한하지 않는다 — 각 화면이 그리드로 넓은 화면을 나눠 쓴다.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser("/app");
  return (
    <div className="flex w-full flex-1 flex-col lg:flex-row">
      <AppSidebar email={user.email} showConnections={cliProvidersEnabled()} env={appEnv()} />
      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 print:p-0">{children}</main>
    </div>
  );
}
