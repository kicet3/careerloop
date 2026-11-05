"use client";

/**
 * 심사위원 한 명과의 대화 패널. 최근 대화를 불러와 이어 가고, '새 대화'로 처음부터 시작할 수 있다.
 * 답변의 수정안(before → after)은 복사할 수 있고, 되묻는 질문은 눌러서 입력창에 넣는다.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { MAX_CHAT_MESSAGE_CHARS, type ChatMessage, type ChatThread, type ReviewerFeedbackData } from "@/lib/domain/chat";
import { REVIEWERS } from "@/lib/domain/reviewers";
import type { ReviewerId } from "@/lib/domain/schemas";

type ApiError = { error?: string };

/** 받침에 따라 조사를 붙인다(예: 팀장과 / 대표와). */
export function josa(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return `${word}${hasFinal ? withFinal : withoutFinal}`;
}

async function readJson<T>(res: Response): Promise<T & ApiError> {
  return ((await res.json().catch(() => null)) ?? {}) as T & ApiError;
}

const STARTERS: Record<ReviewerId, string[]> = {
  ats: ["빠진 키워드를 거짓 없이 넣으려면 어떻게 고쳐야 하나요?", "직함·날짜 표기를 어떻게 정리하면 통과할까요?"],
  gatekeeper: ["처음 10초에 걸린 부분을 어떻게 고치면 좋을까요?", "가장 약한 줄 3개를 어떻게 바꾸면 될까요?"],
  manager: ["첫날부터 일할 수 있다는 증거를 어떻게 보여 줄까요?", "가장 치명적인 줄을 어떻게 고치면 될까요?"],
  rival: ["다른 지원자보다 밀리는 부분을 어떻게 보완할까요?", "가장 치명적인 줄을 어떻게 고치면 될까요?"],
  ceo: ["임팩트가 드러나게 경력 불릿을 어떻게 고칠까요?", "'참여', '기여' 같은 표현을 어떻게 바꿀까요?"],
  recruiter: ["상단 3분의 1을 어떻게 바꾸면 30초 안에 눈에 띌까요?", "요약 문단을 어떻게 고치면 좋을까요?"],
  teammate: ["팀 성과에서 제 몫이 드러나게 하려면 어떻게 쓰나요?", "협업 경험을 어떤 식으로 보여 주면 좋을까요?"],
};

/** 패널 바깥(시트)이 닫기 전에 확인할 상태. */
export interface ReviewerChatActivity {
  sending: boolean;
  draft: string;
}

export function ReviewerChatPanel({
  diagnosisId,
  reviewer,
  onActivity,
}: {
  diagnosisId: string;
  reviewer: ReviewerId;
  onActivity?: (activity: ReviewerChatActivity) => void;
}) {
  const meta = REVIEWERS[reviewer];
  const base = `/api/diagnoses/${encodeURIComponent(diagnosisId)}/chat`;
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadThread = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${base}/${encodeURIComponent(id)}`, { cache: "no-store" });
        const data = await readJson<{ thread: ChatThread; messages: ChatMessage[] }>(res);
        if (!res.ok) throw new Error(data.error ?? "대화를 불러오지 못했습니다.");
        setThreadId(id);
        setMessages(data.messages);
      } catch (err) {
        setError(err instanceof Error ? err.message : "대화를 불러오지 못했습니다.");
      } finally {
        setLoading(false);
      }
    },
    [base],
  );

  // 처음 열 때: 이 심사위원과의 최근 대화를 이어 간다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${base}?reviewer=${reviewer}`, { cache: "no-store" });
        const data = await readJson<{ threads: ChatThread[] }>(res);
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? "대화 목록을 불러오지 못했습니다.");
        setThreads(data.threads);
        if (data.threads[0]) await loadThread(data.threads[0].id);
        else setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "대화 목록을 불러오지 못했습니다.");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [base, reviewer, loadThread]);

  useEffect(() => {
    onActivity?.({ sending, draft });
  }, [onActivity, sending, draft]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    setPending(message);
    setDraft("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewer, message, threadId }),
        signal: ctrl.signal,
      });
      const data = await readJson<{ thread: ChatThread; messages: ChatMessage[] }>(res);
      if (!res.ok) throw new Error(data.error ?? "답변을 받지 못했습니다.");
      setMessages((prev) => (threadId === data.thread.id ? [...prev, ...data.messages] : data.messages));
      setThreadId(data.thread.id);
      setThreads((prev) => [data.thread, ...prev.filter((t) => t.id !== data.thread.id)]);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      // 실패하면 보낸 글을 되돌려 다시 보낼 수 있게 한다. 기다리는 동안 새로 쓴 글은 지우지 않고 뒤에 둔다.
      setDraft((d) => (d.trim() ? `${message}\n${d}` : message));
      setError(err instanceof Error && err.message !== "Failed to fetch" ? err.message : "서버에 연결하지 못했습니다.");
    } finally {
      setPending(null);
      setSending(false);
      if (abortRef.current === ctrl) abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  function newThread() {
    if (sending) return;
    setThreadId(null);
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  }

  async function removeThread() {
    if (!threadId || sending) return;
    if (!window.confirm("이 대화를 삭제할까요? 되돌릴 수 없습니다.")) return;
    try {
      const res = await fetch(`${base}/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const data = await readJson<object>(res);
        throw new Error(data.error ?? "대화를 삭제하지 못했습니다.");
      }
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      newThread();
    } catch (err) {
      setError(err instanceof Error ? err.message : "대화를 삭제하지 못했습니다.");
    }
  }

  function fillInput(text: string) {
    setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${text}` : text));
    inputRef.current?.focus();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 sm:px-5">
        {threads.length > 0 ? (
          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-slate-500">
            <span className="shrink-0">대화</span>
            <select
              className="h-8 min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none"
              value={threadId ?? ""}
              disabled={sending || loading}
              onChange={(e) => (e.target.value ? void loadThread(e.target.value) : newThread())}
            >
              <option value="">새 대화</option>
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title || "제목 없음"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="flex-1 text-xs text-slate-500">받은 피드백을 어떻게 고칠지 물어보세요.</p>
        )}
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={newThread} disabled={sending || !threadId}>
            새 대화
          </Button>
          {threadId && (
            <Button variant="ghost" size="sm" onClick={removeThread} disabled={sending} className="text-slate-500 hover:text-red-700">
              삭제
            </Button>
          )}
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
        {loading ? (
          <div className="flex justify-center py-10 text-slate-400">
            <Spinner label="대화를 불러오는 중" />
          </div>
        ) : (
          <>
            {messages.length === 0 && !pending && (
              <div className="space-y-3">
                <p className="text-sm leading-relaxed text-slate-600">
                  {meta.name}의 기준({meta.role})으로 피드백을 어떻게 고칠지 함께 봅니다. 고친 문장을 붙여넣으면 같은 기준으로
                  다시 평가합니다.
                </p>
                <div className="flex flex-col items-start gap-2">
                  {STARTERS[reviewer].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      disabled={sending}
                      className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-left text-sm text-indigo-800 hover:border-indigo-300 hover:bg-indigo-100 disabled:opacity-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} text={m.content} />
              ) : (
                <AssistantMessage key={m.id} name={meta.name} message={m} onQuestion={fillInput} />
              ),
            )}
            {pending && (
              <>
                <UserBubble text={pending} />
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner size="sm" /> {josa(meta.name, "이", "가")} 답변을 쓰는 중…
                </div>
              </>
            )}
          </>
        )}
      </div>

      <form onSubmit={onSubmit} className="border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
        {error && (
          <Alert tone="error" className="mb-2">
            {error}
          </Alert>
        )}
        <label htmlFor={`reviewer-chat-input-${reviewer}`} className="sr-only">
          {meta.name}에게 보낼 메시지
        </label>
        <textarea
          id={`reviewer-chat-input-${reviewer}`}
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          maxLength={MAX_CHAT_MESSAGE_CHARS}
          placeholder="질문하거나 고친 문장을 붙여넣으세요. (Enter 보내기, Shift+Enter 줄바꿈)"
          className="block w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
          disabled={loading}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            AI 심사위원의 의견입니다. 없는 사실은 [ADD]로 남깁니다.
          </p>
          <Button type="submit" size="sm" loading={sending} disabled={loading || !draft.trim()}>
            보내기
          </Button>
        </div>
      </form>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-white">
        {text}
      </p>
    </div>
  );
}

function AssistantMessage({
  name,
  message,
  onQuestion,
}: {
  name: string;
  message: ChatMessage;
  onQuestion: (text: string) => void;
}) {
  const data = message.data?.kind === "reviewer-feedback" ? message.data : null;
  return (
    <div className="max-w-[95%] space-y-3">
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">{name}</p>
        <p className="rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800">
          {message.content}
        </p>
      </div>
      {data && <FeedbackDetails data={data} onQuestion={onQuestion} />}
    </div>
  );
}

function FeedbackDetails({ data, onQuestion }: { data: ReviewerFeedbackData; onQuestion: (text: string) => void }) {
  return (
    <>
      {data.suggestedEdits.length > 0 && (
        <ol className="space-y-2">
          {data.suggestedEdits.map((e, i) => (
            <SuggestedEditCard key={i} index={i + 1} edit={e} />
          ))}
        </ol>
      )}
      {data.verdictOutlook && (
        <p className="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs leading-relaxed text-indigo-900">
          <span className="font-semibold">판단 전망(추정)</span> · {data.verdictOutlook}
        </p>
      )}
      {data.followUpQuestions.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-slate-500">더 알려 주면 정확해져요 — 눌러서 답하기</p>
          <div className="flex flex-col items-start gap-1.5">
            {data.followUpQuestions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onQuestion(`Q. ${q}\nA. `)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-sm text-slate-700 hover:border-indigo-300 hover:text-indigo-800"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SuggestedEditCard({ index, edit }: { index: number; edit: ReviewerFeedbackData["suggestedEdits"][number] }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(edit.after);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 복사 권한이 없으면 사용자가 직접 선택하면 된다
    }
  }
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-500">수정안 {index}</span>
        <button type="button" onClick={copy} className="text-xs font-medium text-indigo-700 hover:text-indigo-900">
          {copied ? "복사됨" : "수정안 복사"}
        </button>
      </div>
      {edit.before != null ? (
        <blockquote
          className={cn(
            "mb-2 border-l-[3px] bg-slate-50 px-3 py-1.5 leading-relaxed break-words text-slate-500 line-through decoration-slate-300",
            edit.quoteVerified === false ? "border-amber-400" : "border-slate-300",
          )}
        >
          {edit.before}
        </blockquote>
      ) : (
        <p className="mb-2 text-xs text-slate-400">새로 추가</p>
      )}
      {edit.quoteVerified === false && (
        <p className="-mt-1 mb-2 text-xs text-amber-700">원문과 글자가 달라요 — 이력서에서 해당 줄을 직접 확인해 주세요.</p>
      )}
      <p className="border-l-[3px] border-emerald-400 bg-emerald-50 px-3 py-1.5 leading-relaxed break-words whitespace-pre-wrap text-slate-900">
        {edit.after}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{edit.reason}</p>
    </li>
  );
}
