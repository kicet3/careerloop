"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PROVIDER_DESCRIPTIONS, PROVIDER_LABELS, type ProviderConnection } from "@/lib/domain/providers";

const ACTIVE_PHASES = ["starting", "waiting", "verifying"];

const STEPS: Record<ProviderConnection["id"], string[]> = {
  "claude-cli": [
    "아래 [로그인 링크 열기]로 Claude 로그인 페이지를 엽니다.",
    "Claude Pro·Max 계정으로 로그인하고 승인하면 코드가 표시됩니다.",
    "그 코드를 복사해 이 화면의 입력칸에 붙여넣습니다.",
  ],
  "codex-cli": [
    "아래 [인증 페이지 열기]로 OpenAI 기기 인증 페이지를 엽니다.",
    "ChatGPT 계정으로 로그인한 뒤, 이 화면의 1회용 코드를 입력합니다.",
    "승인이 끝나면 이 화면이 자동으로 '연결됨'으로 바뀝니다.",
  ],
};

/**
 * canManage: 관리자만 true. false면 상태만 보여 주고 로그인·해제·상태 새로고침 버튼과 로그인 진행 패널을 그리지 않는다
 * (그 API는 관리자 전용이다). 일반 사용자는 페이지를 새로고침해 최신 상태를 본다.
 */
export function ProviderConnections({ initial, canManage }: { initial: ProviderConnection[]; canManage: boolean }) {
  return (
    <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
      {initial.map((c) => (
        <ProviderCard key={c.id} initial={c} canManage={canManage} />
      ))}
    </div>
  );
}

function ProviderCard({ initial, canManage }: { initial: ProviderConnection; canManage: boolean }) {
  const [conn, setConn] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const login = canManage ? conn.login : null;
  const active = !!login && ACTIVE_PHASES.includes(login.phase);

  const failures = useRef(0);
  const [pollStopped, setPollStopped] = useState(false);

  const refresh = useCallback(
    async (fresh = false) => {
      try {
        const res = await fetch(`/api/providers/${conn.id}${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as (ProviderConnection & { error?: string }) | null;
        if (res.ok && data) {
          failures.current = 0;
          setConn(data);
          return;
        }
        // 4xx(세션 만료 등)는 다시 해도 같으므로 바로 멈춘다.
        if (res.status >= 400 && res.status < 500) {
          setPollStopped(true);
          setError(data?.error ?? (res.status === 401 ? "로그인이 만료되었습니다. 이 사이트에 다시 로그인해 주세요." : "상태를 불러오지 못했습니다."));
          return;
        }
      } catch {
        // 네트워크 오류는 아래에서 횟수를 센다.
      }
      failures.current += 1;
      if (failures.current >= 5) {
        setPollStopped(true);
        setError("서버에서 로그인 상태를 받아오지 못했습니다. [상태 새로고침]으로 다시 확인해 주세요.");
      }
    },
    [conn.id],
  );

  // 로그인 진행 중이면 2초마다 상태를 읽는다(브라우저에서 승인하면 CLI가 끝나고 '연결됨'으로 바뀐다).
  useEffect(() => {
    if (!active || pollStopped) return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [active, pollStopped, refresh]);

  async function act(action: "login" | "code" | "cancel" | "logout", extra: Record<string, string> = {}) {
    setBusy(action);
    setError(null);
    setPollStopped(false);
    failures.current = 0;
    try {
      const res = await fetch(`/api/providers/${conn.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const data = (await res.json().catch(() => null)) as (ProviderConnection & { error?: string }) | null;
      if (!res.ok || !data) {
        setError(data?.error ?? "요청을 처리하지 못했습니다.");
        return;
      }
      setConn(data);
      if (action === "code") setCode("");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  const { status } = conn;
  const statusBadge = !status.installed ? (
    <Badge tone="negative">CLI 없음</Badge>
  ) : status.loggedIn ? (
    <Badge tone="positive">연결됨</Badge>
  ) : (
    <Badge tone="neutral">연결 안 됨</Badge>
  );

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            {PROVIDER_LABELS[conn.id]} {statusBadge}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{PROVIDER_DESCRIPTIONS[conn.id]}</p>
          {status.loggedIn && status.account && (
            <p className="mt-2 text-sm text-slate-700">
              계정: <span className="font-medium">{status.account}</span>
            </p>
          )}
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            {!conn.systemLogin && status.installed && !active && (
              status.loggedIn ? (
                <Button variant="danger" size="sm" loading={busy === "logout"} onClick={() => void act("logout")}>
                  연결 해제
                </Button>
              ) : (
                <Button size="sm" loading={busy === "login"} onClick={() => void act("login")}>
                  로그인
                </Button>
              )
            )}
            {(!active || pollStopped) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError(null);
                  setPollStopped(false);
                  failures.current = 0;
                  void refresh(true);
                }}
              >
                상태 새로고침
              </Button>
            )}
          </div>
        )}
      </div>

      {canManage && conn.systemLogin && (
        <p className="mt-3 text-sm text-slate-500">
          서버 PC의 기본 CLI 로그인을 그대로 쓰는 설정입니다. 로그인·로그아웃은 서버 PC의 터미널에서 해 주세요.
        </p>
      )}
      {canManage && !status.installed && (
        <Alert tone="warning" className="mt-4">
          서버 PC에서 <code>{conn.id === "claude-cli" ? "claude" : "codex"}</code> 명령을 찾지 못했습니다.{" "}
          {conn.id === "claude-cli" ? "Claude Code" : "Codex CLI"}를 설치하거나 경로를{" "}
          <code>{conn.id === "claude-cli" ? "CLAUDE_CLI_PATH" : "CODEX_CLI_PATH"}</code>에 지정해 주세요.
        </Alert>
      )}
      {canManage && status.installed && !status.loggedIn && status.error && !active && (
        <p className="mt-3 text-sm text-amber-700">{status.error}</p>
      )}

      {login && active && (
        <div className="mt-5 rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            {STEPS[conn.id].map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {login.url && (
            <a
              href={login.url}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass("primary", "md", "mt-4")}
            >
              {conn.id === "claude-cli" ? "로그인 링크 열기" : "인증 페이지 열기"} ↗
            </a>
          )}
          {login.userCode && (
            <div className="mt-4">
              <p className="text-sm text-slate-600">1회용 코드(15분 안에 입력)</p>
              <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-slate-900 select-all">{login.userCode}</p>
            </div>
          )}
          {login.needsCode && login.phase === "waiting" && (
            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) void act("code", { code: code.trim() });
              }}
            >
              <input
                aria-label="로그인 코드"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="로그인 페이지에 표시된 코드를 붙여넣기"
                className="block w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
              />
              <Button type="submit" loading={busy === "code"} disabled={!code.trim()}>
                코드 제출
              </Button>
            </form>
          )}
          <div className="mt-4 flex items-center gap-3 text-sm text-slate-500">
            {login.phase === "verifying" ? "로그인을 확인하는 중…" : login.phase === "starting" ? "로그인을 준비하는 중…" : "승인을 기다리는 중…"}
            <Button variant="ghost" size="sm" loading={busy === "cancel"} onClick={() => void act("cancel")}>
              취소
            </Button>
          </div>
        </div>
      )}

      {login && login.phase === "failed" && login.message && (
        <Alert tone="error" className="mt-4">
          {login.message}
        </Alert>
      )}
      {login && login.phase === "succeeded" && status.loggedIn && (
        <Alert tone="info" className="mt-4">
          연결되었습니다. 새 진단에서 &lsquo;{PROVIDER_LABELS[conn.id]}&rsquo; 엔진을 고를 수 있습니다.
        </Alert>
      )}
      {error && (
        <Alert tone="error" className="mt-4">
          {error}
        </Alert>
      )}
    </Card>
  );
}
