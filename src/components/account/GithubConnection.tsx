"use client";

/**
 * 계정 설정 > 연결된 서비스 > GitHub. 연결(폼 POST /api/github/connect → GitHub), 연결 해제, 비공개 저장소 허용 토글.
 * 설정이 없으면(운영자가 GitHub App을 만들지 않음) 안내만 보인다. 토큰은 화면에 오지 않는다.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { githubApi, GithubClientError } from "@/components/github/client";
import { Alert, Badge, Button } from "@/components/ui";
import type { GithubStatusView } from "@/lib/github/types";

const UNINSTALL_URL = "https://github.com/settings/installations";
const DISCONNECT_CONFIRM = "GitHub 접근 권한을 해지하고 가져온 저장소 정보를 지웁니다. 경험 그래프에 적용한 내용은 남습니다.";

export function GithubConnection({ initial, flash }: { initial: GithubStatusView; flash: { tone: "ok" | "error"; text: string } | null }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [pending, setPending] = useState<"disconnect" | "private" | null>(null);
  const [message, setMessage] = useState(flash);

  if (!status.configured) {
    return (
      <div className="space-y-3">
        <Alert tone="info" title="관리자가 GitHub 연동을 아직 설정하지 않았습니다">
          설정되면 여기에서 GitHub 계정을 연결하고, 경험 그래프에서 저장소를 골라 프로젝트를 정리할 수 있습니다.
        </Alert>
        {status.connected && (
          // 예전에 연결해 둔 기록이 남아 있으면 지울 수 있게 한다(설정이 없으니 GitHub 권한 해지는 건너뛴다).
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-700">@{status.login} 연결 기록과 가져온 저장소 정보가 남아 있습니다.</span>
            <Button size="sm" variant="danger" loading={pending === "disconnect"} onClick={disconnect}>
              연결 해제
            </Button>
          </div>
        )}
        {message && (
          <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"}>
            {message.text}
          </p>
        )}
      </div>
    );
  }

  async function disconnect() {
    if (pending || !window.confirm(DISCONNECT_CONFIRM)) return;
    setPending("disconnect");
    setMessage(null);
    try {
      const r = await githubApi.disconnect();
      setStatus(r.status);
      setMessage({
        tone: "ok",
        text: r.revoked
          ? "GitHub 연결을 해제했습니다."
          : "연결 정보를 지웠습니다. GitHub에서 권한을 해지하지 못했으니 GitHub 설정에서 앱을 직접 제거해 주세요.",
      });
      router.refresh();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof GithubClientError ? err.message : "연결을 해제하지 못했습니다." });
    }
    setPending(null);
  }

  async function togglePrivate(next: boolean) {
    if (pending) return;
    setPending("private");
    setMessage(null);
    try {
      setStatus(await githubApi.setIncludePrivate(next));
      setMessage({ tone: "ok", text: next ? "비공개 저장소도 가져올 수 있게 했습니다." : "이제 공개 저장소만 가져옵니다." });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof GithubClientError ? err.message : "저장하지 못했습니다." });
    }
    setPending(null);
  }

  const connectForm = (label: string, variant: "primary" | "secondary" = "primary") => (
    <form method="post" action="/api/github/connect">
      <input type="hidden" name="next" value="/app/account#github" />
      <Button type="submit" size="sm" variant={variant}>
        {label}
      </Button>
    </form>
  );

  return (
    <div className="space-y-4">
      {!status.connected ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            GitHub 계정을 연결하면 경험 그래프에서 내 저장소를 골라 프로젝트 단위로 AI와 정리할 수 있습니다. 기본은 공개 저장소만 읽고(읽기 전용),
            저장소 원본은 복제하지 않습니다.
          </p>
          {connectForm("GitHub 연결")}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {status.avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- GitHub 아바타(외부 이미지, 최적화 불필요)
              <img src={status.avatarUrl} alt="" width={36} height={36} className="size-9 rounded-full ring-1 ring-slate-200" referrerPolicy="no-referrer" />
            )}
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-medium text-slate-900">@{status.login}</p>
              {status.connectedAt && <p className="mt-0.5 text-xs text-slate-500">{new Date(status.connectedAt).toLocaleDateString("ko-KR")} 연결</p>}
            </div>
            {status.status === "active" ? <Badge tone="positive">연결됨</Badge> : <Badge tone="warning">다시 연결 필요</Badge>}
          </div>
          {status.status === "reauth_required" && (
            <Alert tone="warning" title="GitHub 연결이 만료되었습니다 — 다시 연결">
              <div className="mt-2">{connectForm("다시 연결")}</div>
            </Alert>
          )}
          <div className="rounded-lg border border-slate-200 p-3">
            <label className="flex items-start gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={status.includePrivate}
                disabled={pending !== null}
                onChange={(e) => togglePrivate(e.target.checked)}
              />
              <span>
                비공개 저장소도 가져오기
                <span className="mt-1 block text-xs text-slate-500">
                  켜면 고른 비공개 저장소의 README 앞부분·커밋 메시지·의존성 이름 등이 AI(Anthropic)로 보내져 처리됩니다. GitHub에서도 이 앱에 그 저장소를
                  허용해야 읽을 수 있습니다.
                </span>
              </span>
            </label>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {status.installUrl && (
                <a href={status.installUrl} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 underline underline-offset-2">
                  GitHub에서 저장소 선택/설치
                </a>
              )}
              <a href={UNINSTALL_URL} target="_blank" rel="noreferrer" className="text-slate-600 underline underline-offset-2">
                GitHub에서 앱 제거
              </a>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="danger" loading={pending === "disconnect"} onClick={disconnect}>
              연결 해제
            </Button>
            <span className="text-xs text-slate-500">해제하면 가져온 저장소 정보가 지워집니다. 경험 그래프에 적용한 내용은 남습니다.</span>
          </div>
        </div>
      )}
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
