import type { Metadata } from "next";
import { ProviderConnections } from "@/components/app/ProviderConnections";
import { Alert } from "@/components/ui/Alert";
import { requireUser } from "@/lib/auth/session";
import { cliProvidersEnabled } from "@/lib/providers/cli";
import { listConnections } from "@/lib/providers/service";

export const metadata: Metadata = { title: "AI 연결" };
export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  await requireUser("/app/connections");
  const enabled = cliProvidersEnabled();
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">AI 연결</h1>
      <p className="mt-1 mb-6 max-w-prose text-sm text-slate-500">
        API 키 대신 Claude 구독 계정이나 ChatGPT 계정으로 로그인해 진단을 돌립니다. 서버 PC의 Claude Code·Codex CLI를 통해
        호출하며, 로그인 정보는 이 앱 전용 폴더(<code>data/providers</code>)에만 저장됩니다.
      </p>
      {enabled ? (
        <>
          <ProviderConnections initial={await listConnections()} />
          <Alert tone="warning" title="임시·개인용 기능입니다" className="mt-6">
            연결한 계정의 구독 사용량으로 진단이 실행되고, 이 서버에 로그인한 모든 사용자가 그 계정을 쓰게 됩니다. 본인 PC에서
            혼자 쓸 때만 켜 두세요. 구독 계정을 다른 사람에게 서비스로 제공하는 것은 각 회사 약관에 어긋날 수 있습니다.
          </Alert>
        </>
      ) : (
        <Alert tone="info" title="CLI 엔진이 꺼져 있습니다">
          서버의 <code>.env.local</code>에 <code>CLI_PROVIDERS=1</code>을 넣고 서버를 다시 시작하면 이 화면에서 로그인할 수
          있습니다. 서버 PC에 Claude Code(<code>claude</code>)나 Codex CLI(<code>codex</code>)가 설치되어 있어야 합니다.
        </Alert>
      )}
    </div>
  );
}
