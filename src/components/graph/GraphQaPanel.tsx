"use client";
/**
 * 그래프에 묻기 패널(기능 B). 경험 그래프만 근거로 답하고, 문장마다 [n] 출처(그래프 노드와 본인에서의 경로)를 단다.
 * - 질문 전송은 202로 바로 끝나고 답은 서버가 백그라운드로 만든다 → 답을 기다리는 동안 스레드를 폴링한다.
 * - 출처 칩·[n]을 누르면 같은 화면의 그래프 보기가 그 노드를 고르고 경로를 강조한다(career-graph:focus).
 * - 그래프에 답이 없으면 채울 방법(그래프 만들기 채팅 문구·체크리스트)을 보여 준다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Spinner, cn } from "@/components/ui";
import type { GraphQaThreadView } from "@/lib/chat/graph-qa";
import { type ChatMessage, type ChatThread, MAX_QA_QUESTION_CHARS } from "@/lib/domain/chat";
import { NO_ENGINE_MESSAGE, type ProviderId } from "@/lib/domain/providers";
import { askGraphChat } from "./api";
import { chatApi as api, useElapsed, useProviderChoice } from "./chat-client";
import { AnswerText, SourceChips } from "./CitationChips";

const PROVIDER_STORAGE_KEY = "graph-qa:provider";
const EXAMPLES = ["내 대표 성과를 수치로 정리해 줘", "리더십을 보여 줄 경험이 있어?", "어떤 기술을 어디에서 썼어?", "자기소개용으로 경력을 요약해 줘"];

export function GraphQaPanel() {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [graphOn, setGraphOn] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [loadedView, setView] = useState<GraphQaThreadView | null>(null);
  const view = loadedView && loadedView.thread.id === threadId ? loadedView : null;
  const { ready: readyProviders, provider, choose, noEngine } = useProviderChoice(PROVIDER_STORAGE_KEY);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    api<{ threads: ChatThread[]; graphEnabled: boolean }>("/api/graph/qa/threads")
      .then((r) => {
        if (!alive) return;
        setThreads(r.threads);
        setGraphOn(r.graphEnabled);
        setThreadId((cur) => (cur && r.threads.some((t) => t.id === cur) ? cur : (r.threads[0]?.id ?? null)));
      })
      .catch((e: Error) => alive && (setThreads([]), setError(e.message)));
    return () => {
      alive = false;
    };
  }, []);

  const loadThread = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    const v = await api<GraphQaThreadView>(`/api/graph/qa/threads/${encodeURIComponent(id)}`);
    if (seq === loadSeq.current) setView(v);
    return v;
  }, []);

  useEffect(() => {
    if (!threadId) return;
    loadThread(threadId).catch((e: Error) => setError(e.message));
  }, [threadId, loadThread]);

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
          api<{ threads: ChatThread[] }>("/api/graph/qa/threads").then((r) => setThreads(r.threads), () => {});
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

  const messageCount = view?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, pending, threadId]);

  const elapsed = useElapsed(pending ? lastCreatedAt : null);

  async function send(question = input) {
    const text = question.trim();
    if (!text || sending || pending) return;
    if (text.length > MAX_QA_QUESTION_CHARS) {
      setError(`질문은 ${MAX_QA_QUESTION_CHARS}자까지 보낼 수 있습니다.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      let id = threadId;
      if (!id) {
        const r = await api<{ thread: ChatThread }>("/api/graph/qa/threads", { method: "POST", json: {} });
        id = r.thread.id;
        setThreads((ts) => [r.thread, ...(ts ?? [])]);
        setThreadId(id);
      }
      await api(`/api/graph/qa/threads/${encodeURIComponent(id)}/messages`, { method: "POST", json: { message: text, provider } });
      setInput("");
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
      await api(`/api/graph/qa/threads/${encodeURIComponent(threadId)}/retry`, { method: "POST", json: { provider } });
      await loadThread(threadId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function removeThread() {
    if (!threadId || !window.confirm("이 질문 대화를 지울까요? 그래프는 그대로 남습니다.")) return;
    setError(null);
    try {
      await api(`/api/graph/qa/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      const rest = (threads ?? []).filter((t) => t.id !== threadId);
      setThreads(rest);
      setThreadId(rest[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const disabled = !graphOn || noEngine;
  const messages = view?.messages ?? [];
  const lastId = messages.at(-1)?.id;

  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="w-full text-base font-semibold text-slate-900">내 경험 그래프에 묻기</h2>
        <label className="sr-only" htmlFor="graph-qa-thread">
          질문 대화 선택
        </label>
        <select
          id="graph-qa-thread"
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          value={threadId ?? ""}
          onChange={(e) => setThreadId(e.target.value || null)}
          disabled={threads === null}
        >
          <option value="">{threadId ? "새 질문" : "새 질문(작성 중)"}</option>
          {threads?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setThreadId(null);
            setError(null);
            inputRef.current?.focus();
          }}
          disabled={!threadId}
        >
          새 질문
        </Button>
        {threadId && (
          <Button size="sm" variant="ghost" onClick={removeThread} aria-label="이 질문 대화 삭제">
            삭제
          </Button>
        )}
      </div>

      {readyProviders.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-sm text-slate-600">
          <label htmlFor="graph-qa-provider">AI 엔진</label>
          <select
            id="graph-qa-provider"
            className="h-8 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
            value={provider ?? ""}
            onChange={(e) => choose(e.target.value as ProviderId)}
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

      <div ref={listRef} className="h-[min(60vh,560px)] min-h-72 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {!graphOn && <Alert tone="warning">경험 그래프 저장소(Neo4j)가 설정되지 않아 질문할 수 없습니다.</Alert>}
        {noEngine && <Alert tone="warning">{NO_ENGINE_MESSAGE}</Alert>}
        {threadId && !view && (
          <div className="flex justify-center py-10 text-slate-400">
            <Spinner label="대화를 불러오는 중" />
          </div>
        )}
        {(!threadId || (view && messages.length === 0)) && (
          <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm leading-relaxed text-slate-600">
            <p className="font-medium text-slate-800">내 경력에 대해 물어보세요</p>
            <p className="mt-1">답은 경험 그래프에 정리된 내용만으로 만들고, 문장마다 근거 항목을 [번호]로 달아 드려요. 번호를 누르면 그래프에서 위치를 보여 줍니다.</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {EXAMPLES.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={disabled || sending}
                  onClick={() => void send(q)}
                  className="rounded-full border border-indigo-200 bg-white px-2.5 py-1 text-xs text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
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
            <AnswerMessage key={m.id} message={m} canRetry={m.id === lastId && (view?.canRetry ?? false)} onRetry={retry} retrying={sending} />
          ),
        )}
        {pending && (
          <div className="flex items-center gap-2 text-sm text-slate-500" role="status">
            <Spinner size="sm" />
            <span>
              그래프에서 찾는 중… {elapsed > 0 && `${elapsed}초`}
              {elapsed >= 20 && <span className="block text-xs text-slate-400">엔진에 따라 1분 이상 걸릴 수 있어요. 이 화면을 떠나도 답은 저장됩니다.</span>}
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
          <label htmlFor="graph-qa-input" className="sr-only">
            그래프에 질문하기
          </label>
          <textarea
            id="graph-qa-input"
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={disabled}
            placeholder={pending ? "답변을 기다리는 중입니다…" : "예: 결제 개선 프로젝트 성과가 뭐였어? (Enter 전송)"}
            className="max-h-40 min-h-[2.75rem] min-w-0 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:bg-slate-50"
          />
          <Button type="submit" loading={sending} disabled={disabled || pending || !input.trim()}>
            묻기
          </Button>
        </form>
        <p className={cn("mt-1 text-right text-xs", input.length > MAX_QA_QUESTION_CHARS ? "text-red-600" : "text-slate-400")}>
          {input.length.toLocaleString()} / {MAX_QA_QUESTION_CHARS.toLocaleString()}
        </p>
      </div>
    </Card>
  );
}

function AnswerMessage({ message: m, canRetry, onRetry, retrying }: { message: ChatMessage; canRetry: boolean; onRetry: () => void; retrying: boolean }) {
  if (m.status === "failed" && m.data === null) {
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
  const data = m.data?.kind === "graph-answer" ? m.data : null;
  const sources = data?.sources ?? [];
  return (
    <div className="flex">
      <div className="max-w-[95%] min-w-0 space-y-2">
        <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2">
          <AnswerText text={m.content} sources={sources} />
        </div>
        <SourceChips sources={sources} />
        {data && (data.insufficient || !data.grounded) && (
          <Alert tone="warning" title={data.grounded ? "그래프에 정보가 부족해요" : "그래프에서 근거를 찾지 못한 답입니다"}>
            {data.missingInfo.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4">
                {data.missingInfo.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.suggestions.map((s) => (
                <button
                  key={s.categoryId}
                  type="button"
                  onClick={() => askGraphChat(s.chatStarter)}
                  className="rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs text-amber-900 hover:bg-amber-100"
                >
                  {s.name} 채우기
                </button>
              ))}
              <button
                type="button"
                onClick={() => document.getElementById("experience-checklist")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
              >
                체크리스트 보기
              </button>
            </div>
          </Alert>
        )}
        {data?.debug && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">검색·리랭크 정보(개발용)</summary>
            <div className="mt-1 space-y-1 rounded border border-slate-200 bg-white p-2 font-mono text-[11px]">
              <p>
                의도 {data.debug.intents.join(", ") || "-"} · 기술 {data.debug.skills.join(", ") || "-"} · 태그 {data.debug.tags.join(", ") || "-"}
                {data.debug.fallback && " · 폴백"}
              </p>
              <p>
                LLM 리랭크 {data.debug.llmRerank.used ? `사용(${data.debug.llmRerank.ms ?? 0}ms)` : `건너뜀 — ${data.debug.llmRerank.reason ?? ""}`} · 컨텍스트{" "}
                {data.debug.contextChars.toLocaleString()}자{data.droppedCitations?.length ? ` · 무효 인용 ${data.droppedCitations.join(", ")}` : ""}
              </p>
              <ol className="list-decimal pl-5">
                {data.debug.pool.map((p) => (
                  <li key={p.id} className="break-words">
                    {p.name} ({p.label}) final {p.final} · det {p.det}
                    {p.llm !== undefined && ` · llm ${p.llm}`}
                  </li>
                ))}
              </ol>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
