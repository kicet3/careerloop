"use client";

/**
 * MCP 토큰 만들기·목록·폐기. 만든 토큰 원문은 이 화면에서 한 번만 보인다(서버는 해시만 둔다).
 * 연결 방법(McpSetupGuide)도 여기서 그려, 방금 만든 토큰을 설정 예시에 바로 넣는다.
 */
import { useState, type FormEvent } from "react";
import { formatDateTime } from "@/components/app/stages";
import { Alert, Badge, Button, Card, CardBody, CardHeader, type BadgeTone } from "@/components/ui";
import {
  DEFAULT_MCP_TOKEN_EXPIRY,
  DEFAULT_MCP_TOKEN_NAME,
  MAX_ACTIVE_MCP_TOKENS,
  MAX_MCP_TOKEN_NAME,
  MCP_TOKEN_EXPIRY_LABELS,
  MCP_TOKEN_EXPIRY_OPTIONS,
  MCP_TOKEN_STATUS_LABELS,
  type McpTokenExpiry,
  type McpTokenStatus,
  type McpTokenView,
} from "@/lib/domain/mcp";
import { createMcpTokenRequest, revokeMcpTokenRequest } from "./api";
import { CopyButton, McpSetupGuide } from "./McpSetupGuide";

const STATUS_TONE: Record<McpTokenStatus, BadgeTone> = { active: "positive", expired: "warning", revoked: "neutral" };

const expiryKey = (v: McpTokenExpiry) => (v === null ? "none" : String(v));

export function McpTokens({ initial, endpoint }: { initial: McpTokenView[]; endpoint: string }) {
  const [tokens, setTokens] = useState(initial);
  const [name, setName] = useState(DEFAULT_MCP_TOKEN_NAME);
  const [expiry, setExpiry] = useState<McpTokenExpiry>(DEFAULT_MCP_TOKEN_EXPIRY);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const activeCount = tokens.filter((t) => t.status === "active").length;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await createMcpTokenRequest({ name: name.trim(), expiresInDays: expiry });
      setTokens((list) => [res.view, ...list]);
      setCreated({ id: res.view.id, token: res.token, name: res.view.name });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(t: McpTokenView) {
    if (!window.confirm(`‘${t.name}’ 토큰을 폐기할까요? 이 토큰으로 연결한 앱은 바로 경험 그래프를 읽지 못합니다.`)) return;
    setRevoking(t.id);
    setError(null);
    try {
      const view = await revokeMcpTokenRequest(t.id);
      setTokens((list) => list.map((x) => (x.id === view.id ? view : x)));
      // 방금 만든 토큰을 폐기했으면 원문 패널과 설정 예시에서도 지운다(폐기한 토큰을 복사해 쓰지 않게).
      setCreated((c) => (c?.id === view.id ? null : c));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="토큰 만들기" description={`연결할 앱마다 따로 만들어 두면 하나만 골라 끊을 수 있습니다. 활성 토큰은 ${MAX_ACTIVE_MCP_TOKENS}개까지입니다.`} />
        <CardBody className="space-y-4">
          <form onSubmit={create} className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-800">이름</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MAX_MCP_TOKEN_NAME}
                required
                placeholder="예: Claude Code"
                className="block w-56 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-800">만료</span>
              <select
                value={expiryKey(expiry)}
                onChange={(e) => setExpiry(e.target.value === "none" ? null : (Number(e.target.value) as McpTokenExpiry))}
                className="block h-[38px] rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
              >
                {MCP_TOKEN_EXPIRY_OPTIONS.map((v) => (
                  <option key={expiryKey(v)} value={expiryKey(v)}>
                    {MCP_TOKEN_EXPIRY_LABELS[expiryKey(v)]}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" loading={creating} disabled={!name.trim() || activeCount >= MAX_ACTIVE_MCP_TOKENS}>
              토큰 만들기
            </Button>
          </form>
          {error && <Alert tone="error">{error}</Alert>}
          {created && (
            <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-900">‘{created.name}’ 토큰을 만들었습니다</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 rounded-md border border-emerald-200 bg-white px-3 py-2 text-sm break-all text-slate-900">{created.token}</code>
                <CopyButton text={created.token} />
              </div>
              <p className="text-xs font-medium text-emerald-900">
                이 화면을 벗어나면 다시 볼 수 없습니다. 지금 복사해 연결할 앱에 넣어 주세요. 비밀번호처럼 다른 사람과 나누지 마세요.
              </p>
              <button type="button" onClick={() => setCreated(null)} className="text-xs text-emerald-800 underline underline-offset-2">
                닫기
              </button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="연결 방법" />
        <CardBody>
          <McpSetupGuide endpoint={endpoint} token={created?.token} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="내 토큰" description="폐기한 토큰은 30일 동안 목록에 남습니다." />
        <CardBody className="pt-3">
          {tokens.length === 0 ? (
            <p className="text-sm text-slate-500">아직 만든 토큰이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="border-b border-slate-200 text-xs text-slate-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">이름</th>
                    <th className="py-2 pr-3 font-medium">토큰</th>
                    <th className="py-2 pr-3 font-medium">만든 날</th>
                    <th className="py-2 pr-3 font-medium">마지막 사용</th>
                    <th className="py-2 pr-3 font-medium">만료</th>
                    <th className="py-2 pr-3 font-medium">상태</th>
                    <th className="py-2 font-medium">
                      <span className="sr-only">동작</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tokens.map((t) => (
                    <tr key={t.id} className={t.status === "active" ? undefined : "text-slate-400"}>
                      <td className="py-2 pr-3 font-medium text-slate-900">{t.name}</td>
                      <td className="py-2 pr-3">
                        <code className="text-xs">{t.prefix}…</code>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{formatDateTime(t.createdAt)}</td>
                      <td className="py-2 pr-3 tabular-nums">{t.lastUsedAt ? formatDateTime(t.lastUsedAt) : "—"}</td>
                      <td className="py-2 pr-3 tabular-nums">{t.expiresAt ? formatDateTime(t.expiresAt) : "없음"}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={STATUS_TONE[t.status]}>{MCP_TOKEN_STATUS_LABELS[t.status]}</Badge>
                      </td>
                      <td className="py-2 text-right">
                        {t.status !== "revoked" && (
                          <Button variant="danger" size="sm" loading={revoking === t.id} onClick={() => revoke(t)}>
                            폐기
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
