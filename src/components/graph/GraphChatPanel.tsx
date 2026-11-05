"use client";
/**
 * 그래프 채팅 패널(기능 2). 경험을 이야기하면 AI가 경력 그래프 변경안을 제안하고, 사용자가 확인하면 적용한다.
 * - 메시지 전송은 202로 바로 끝나고 답변은 서버가 백그라운드로 만든다 → 답을 기다리는 동안 스레드를 폴링한다.
 * - 변경안을 적용하면 window 이벤트 'career-graph:changed'를 보내 그래프 화면이 다시 읽게 한다.
 * - initialMessage가 오면(공고 대조의 '그래프 채팅으로 추가') 새 대화로 열고 입력을 미리 채운다. 보내기는 사용자가 누른다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Spinner, cn } from "@/components/ui";
import type { GraphChatMessageView, GraphThreadView } from "@/lib/chat/graph-chat";
import type { ChatThread } from "@/lib/domain/chat";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import { NO_ENGINE_MESSAGE, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { emitGraphChanged } from "./api";

const PROVIDER_STORAGE_KEY = "graph-chat:provider";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", res.status);
  return data as T;
}

const STATUS_BADGE = {
  proposed: { tone: "accent", label: "확인 대기" },
  applied: { tone: "positive", label: "적용됨" },
  dismissed: { tone: "neutral", label: "거절함" },
  failed: { tone: "negative", label: "적용 실패" },
} as const;

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/**
 * 미리 채운 메시지(?ask=)를 보낸 뒤 주소에서 지운다. 남겨 두면 새로고침할 때 같은 문구가 다시 채워지고 새 대화로 바뀐다.
 * history.replaceState는 Next 라우터와 동기화되며 서버 컴포넌트를 다시 그리지 않는다.
 */
function clearAskQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("ask")) return;
  url.searchParams.delete("ask");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function GraphChatPanel({ initialThreadId, initialMessage }: { initialThreadId?: string; initialMessage?: string }) {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [graphOn, setGraphOn] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId ?? null);
  const [loadedView, setView] = useState<GraphThreadView | null>(null);
  // 다른 스레드를 고른 직후에는 이전 스레드 내용을 보이지 않는다.
  const view = loadedView && loadedView.thread.id === threadId ? loadedView : null;
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [input, setInput] = useState(initialMessage ?? "");
  // 미리 채운 메시지는 새 대화로 시작한다(첫 로드에서 최근 스레드를 고르지 않는다).
  const startFresh = useRef(Boolean(initialMessage) && !initialThreadId);
  const [sending, setSending] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadSeq = useRef(0);
  // 같은 화면에서 다른 기술을 골라 initialMessage가 바뀌면 입력을 다시 채운다(렌더 중 조정 — effect의 setState를 피한다).
  const [seenInitial, setSeenInitial] = useState(initialMessage);
  if (initialMessage !== seenInitial) {
    setSeenInitial(initialMessage);
    if (initialMessage) {
      setInput(initialMessage);
      setThreadId(null);
      setError(null);
    }
  }

  // 미리 채운 메시지가 오면 입력란으로 커서를 옮긴다.
  useEffect(() => {
    if (initialMessage) inputRef.current?.focus();
  }, [initialMessage]);

  // ---- 초기 로드: 스레드 목록·엔진 ----
  useEffect(() => {
    let alive = true;
    api<{ threads: ChatThread[]; graphEnabled: boolean }>("/api/graph/chat/threads")
      .then((r) => {
        if (!alive) return;
        setThreads(r.threads);
        setGraphOn(r.graphEnabled);
        setThreadId((cur) =>
          cur && r.threads.some((t) => t.id === cur) ? cur : startFresh.current ? null : (r.threads[0]?.id ?? null),
        );
      })
      .catch((e: Error) => alive && (setThreads([]), setError(e.message)));
    api<{ options: ProviderOption[] }>("/api/providers")
      .then((r) => {
        if (!alive) return;
        const ready = r.options.filter((o) => o.ready);
        setProviders(r.options);
        const saved = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
        setProvider(ready.find((o) => o.id === saved)?.id ?? ready[0]?.id ?? null);
      })
      .catch(() => alive && setProviders([]));
    return () => {
      alive = false;
    };
  }, []);

  const loadThread = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    const v = await api<GraphThreadView>(`/api/graph/chat/threads/${encodeURIComponent(id)}`);
    if (seq === loadSeq.current) setView(v);
    return v;
  }, []);

  useEffect(() => {
    if (!threadId) return;
    loadThread(threadId).catch((e: Error) => setError(e.message));
  }, [threadId, loadThread]);

  // ---- 답변 대기 중 폴링 ----
  const pending = view?.pending ?? false;
  const lastCreatedAt = view?.messages.at(-1)?.createdAt ?? null;
  useEffect(() => {
    if (!pending || !threadId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const tick = async () => {
      try {
        const v = await loadThread(threadId);
        if (!v.pending || stopped) {
          // 답이 오면 스레드 목록 순서·제목도 갱신한다.
          api<{ threads: ChatThread[] }>("/api/graph/chat/threads").then((r) => setThreads(r.threads), () => {});
          return;
        }
      } catch {
        // 일시적 네트워크 오류는 다음 주기에 다시 시도한다.
      }
      if (!stopped) timer = setTimeout(tick, Date.now() - started > 30_000 ? 4000 : 1500);
    };
    timer = setTimeout(tick, 1200);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, threadId, loadThread]);

  // 새 메시지가 오면 맨 아래로.
  const messageCount = view?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, pending, threadId]);

  const elapsed = useElapsed(pending ? lastCreatedAt : null);
  const readyProviders = providers?.filter((p) => p.ready) ?? [];
  const noEngine = providers !== null && readyProviders.length === 0;

  function chooseProvider(id: ProviderId) {
    setProvider(id);
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, id);
  }

  function newThread() {
    setError(null);
    setThreadId(null);
    setInput("");
    inputRef.current?.focus();
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || pending) return;
    if (text.length > MAX_CHAT_MESSAGE_CHARS) {
      setError(`메시지는 ${MAX_CHAT_MESSAGE_CHARS}자까지 보낼 수 있습니다.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      let id = threadId;
      if (!id) {
        const r = await api<{ thread: ChatThread }>("/api/graph/chat/threads", { method: "POST", json: {} });
        id = r.thread.id;
        setThreads((ts) => [r.thread, ...(ts ?? [])]);
        setThreadId(id);
      }
      await api(`/api/graph/chat/threads/${encodeURIComponent(id)}/messages`, { method: "POST", json: { message: text, provider } });
      setInput("");
      clearAskQuery();
      await loadThread(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function retry() {
    if (!threadId) return;
    setError(null);
    setSending(true);
    try {
      await api(`/api/graph/chat/threads/${encodeURIComponent(threadId)}/retry`, { method: "POST", json: { provider } });
      await loadThread(threadId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function decide(messageId: string, action: "apply" | "dismiss") {
    if (!threadId) return;
    setBusyMessage(messageId);
    setError(null);
    try {
      const r = await api<{ message: GraphChatMessageView; result?: unknown }>(
        `/api/graph/chat/messages/${encodeURIComponent(messageId)}/${action}`,
        { method: "POST" },
      );
      if (action === "apply" && r.message.status === "applied") emitGraphChanged("chat");
      await loadThread(threadId);
    } catch (e) {
      setError((e as Error).message);
      await loadThread(threadId).catch(() => {});
    } finally {
      setBusyMessage(null);
    }
  }

  async function removeThread() {
    if (!threadId || !window.confirm("이 대화를 지울까요? 이미 적용한 그래프 변경은 그대로 남습니다.")) return;
    setError(null);
    try {
      await api(`/api/graph/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      const rest = (threads ?? []).filter((t) => t.id !== threadId);
      setThreads(rest);
      setThreadId(rest[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function askAbout(question: string) {
    setInput((cur) => `${cur ? `${cur}\n` : ""}${question}\n→ `);
    inputRef.current?.focus();
  }

  const disabled = !graphOn || noEngine;
  const messages = view?.messages ?? [];
  const lastId = messages.at(-1)?.id;

  return (
    <Card className="flex min-w-0 flex-col">
      {/* 머리: 스레드·엔진 선택 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="w-full text-base font-semibold text-slate-900">경험 대화로 정리하기</h2>
        <label className="sr-only" htmlFor="graph-chat-thread">
          대화 선택
        </label>
        <select
          id="graph-chat-thread"
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          value={threadId ?? ""}
          onChange={(e) => setThreadId(e.target.value || null)}
          disabled={threads === null}
        >
          <option value="">{threadId ? "새 대화" : "새 대화(작성 중)"}</option>
          {threads?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" onClick={newThread} disabled={!threadId}>
          새 대화
        </Button>
        {threadId && (
          <Button size="sm" variant="ghost" onClick={removeThread} aria-label="이 대화 삭제">
            삭제
          </Button>
        )}
      </div>

      {readyProviders.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-sm text-slate-600">
          <label htmlFor="graph-chat-provider">AI 엔진</label>
          <select
            id="graph-chat-provider"
            className="h-8 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
            value={provider ?? ""}
            onChange={(e) => chooseProvider(e.target.value as ProviderId)}
          >
            {readyProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.account ? ` (${p.account})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 메시지 목록 */}
      <div ref={listRef} className="h-[min(60vh,560px)] min-h-72 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {!graphOn && <Alert tone="warning">경력 그래프 저장소(Neo4j)가 설정되지 않아 대화로 정리할 수 없습니다.</Alert>}
        {noEngine && <Alert tone="warning">{NO_ENGINE_MESSAGE}</Alert>}
        {threadId && !view && (
          <div className="flex justify-center py-10 text-slate-400">
            <Spinner label="대화를 불러오는 중" />
          </div>
        )}
        {(!threadId || (view && messages.length === 0)) && (
          <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm leading-relaxed text-slate-600">
            <p className="font-medium text-slate-800">어떤 경험을 정리할까요?</p>
            <p className="mt-1">
              회사·프로젝트·맡은 일·사용한 기술·결과를 편하게 이야기해 주세요. AI가 그래프에 넣을 변경안을 만들고, 확인한 것만 적용됩니다.
            </p>
            <p className="mt-2 text-slate-500">예: “2022년 3월부터 페이랩에서 백엔드 개발자로 일했고, 결제 API를 Go로 다시 만들어 응답 시간을 40% 줄였어요.”</p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-white">
                {m.content}
              </p>
            </div>
          ) : (
            <AssistantMessage
              key={m.id}
              message={m}
              busy={busyMessage === m.id}
              disabled={!graphOn || busyMessage !== null}
              onApply={() => decide(m.id, "apply")}
              onDismiss={() => decide(m.id, "dismiss")}
              onAsk={askAbout}
              canRetry={m.id === lastId && (view?.canRetry ?? false)}
              onRetry={retry}
              retrying={sending}
            />
          ),
        )}
        {pending && (
          <div className="flex items-center gap-2 text-sm text-slate-500" role="status">
            <Spinner size="sm" />
            <span>
              답변을 만드는 중… {elapsed > 0 && `${elapsed}초`}
              {elapsed >= 20 && <span className="block text-xs text-slate-400">엔진에 따라 1분 이상 걸릴 수 있어요. 이 화면을 떠나도 답변은 저장됩니다.</span>}
            </span>
          </div>
        )}
        {view?.stale && (
          <Alert tone="warning">
            답변을 받지 못했습니다.{" "}
            <button type="button" className="font-semibold underline" onClick={retry} disabled={sending}>
              다시 시도
            </button>
          </Alert>
        )}
      </div>

      {/* 입력 */}
      <div className="border-t border-slate-200 px-4 py-3">
        {error && (
          <Alert tone="error" className="mb-2">
            {error}
          </Alert>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="graph-chat-input" className="sr-only">
            경험 이야기하기
          </label>
          <textarea
            id="graph-chat-input"
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 한글 조합 중 Enter는 무시한다.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={disabled}
            placeholder={pending ? "답변을 기다리는 중입니다…" : "경험을 이야기해 주세요 (Enter 전송, Shift+Enter 줄바꿈)"}
            className="max-h-40 min-h-[2.75rem] min-w-0 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:bg-slate-50"
          />
          <Button type="submit" loading={sending} disabled={disabled || pending || !input.trim()}>
            보내기
          </Button>
        </form>
        <p className={cn("mt-1 text-right text-xs", input.length > MAX_CHAT_MESSAGE_CHARS ? "text-red-600" : "text-slate-400")}>
          {input.length.toLocaleString()} / {MAX_CHAT_MESSAGE_CHARS.toLocaleString()}
        </p>
      </div>
    </Card>
  );
}

function AssistantMessage({
  message: m,
  busy,
  disabled,
  onApply,
  onDismiss,
  onAsk,
  canRetry,
  onRetry,
  retrying,
}: {
  message: GraphChatMessageView;
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onAsk: (q: string) => void;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
}) {
  const replyError = m.status === "failed" && m.data === null;
  if (replyError) {
    return (
      <Alert tone="error">
        {m.content}
        {canRetry && (
          <>
            {" "}
            <button type="button" className="font-semibold underline" onClick={onRetry} disabled={retrying}>
              다시 시도
            </button>
          </>
        )}
      </Alert>
    );
  }
  const proposal = m.data?.kind === "graph-proposal" ? m.data : null;
  const hasOps = !!proposal && proposal.ops.length > 0;
  const badge = hasOps && m.status ? STATUS_BADGE[m.status] : null;
  return (
    <div className="flex">
      <div className="max-w-[92%] min-w-0 space-y-2">
        <p className="rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-slate-800">{m.content}</p>

        {hasOps && (
          <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto font-medium text-slate-900">변경안: {proposal.summary || `${proposal.ops.length}개 변경`}</p>
              {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
            </div>
            <ul className="mt-2 space-y-1 text-slate-700">
              {(m.opLines ?? proposal.ops.map((o) => o.op)).map((line, i) => (
                <li key={i} className="flex gap-1.5 break-words">
                  <span aria-hidden className="text-slate-400">
                    •
                  </span>
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
            {proposal.error && <p className="mt-2 text-red-700">{proposal.error}</p>}
            {m.status === "proposed" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={onApply} loading={busy} disabled={disabled}>
                  그래프에 적용
                </Button>
                <Button size="sm" variant="secondary" onClick={onDismiss} disabled={disabled}>
                  거절
                </Button>
              </div>
            )}
          </div>
        )}

        {proposal?.droppedOps && proposal.droppedOps.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">변경안에서 뺀 항목 {proposal.droppedOps.length}개</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {proposal.droppedOps.map((d, i) => (
                <li key={i} className="break-words">
                  {d}
                </li>
              ))}
            </ul>
          </details>
        )}

        {proposal && proposal.followUpQuestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {proposal.followUpQuestions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAsk(q)}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-left text-xs text-indigo-800 hover:bg-indigo-100"
                title="눌러서 이 질문에 답하기"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
