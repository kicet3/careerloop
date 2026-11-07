"use client";
/**
 * 공개 포트폴리오 화면의 방문자 챗봇: 오른쪽 아래 원형 버튼(56px) → 대화 패널. 640px 이하에서는 화면 아래 전체 폭 시트.
 * - 대화는 이 화면의 메모리에만 있다(저장하지 않는다 — 새로고침하면 사라진다). 질문마다 최근 대화 몇 개만 함께 보낸다.
 * - 패널은 aria-modal 대화 상자: 열면 입력 칸에 초점, Tab은 패널 안에서만 돌고, Esc는 닫고 버튼으로 초점을 돌린다.
 * - 아이폰 홈 표시줄·노치를 피하려고 safe-area inset만큼 띄운다(페이지 viewport-fit=cover).
 * - 640px 이하 시트는 실제 모달이다: 뒤에 어두운 배경(누르면 닫힘)을 깔고, 페이지(헤더·본문)에 inert를 걸고 스크롤을 잠근다.
 *   그보다 넓은 화면의 떠 있는 패널은 페이지를 가리지 않으므로 Tab 순환만 패널 안에 가둔다.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import {
  SHARE_CHAT_DISCLAIMER,
  SHARE_CHAT_MAX_HISTORY,
  SHARE_CHAT_MAX_HISTORY_MESSAGE_CHARS,
  SHARE_CHAT_MAX_QUESTION_CHARS,
  SHARE_CHAT_STARTERS,
  type ShareChatCitation,
  type ShareChatResponse,
} from "@/lib/domain/portfolio-shares";

interface Msg {
  role: "user" | "assistant";
  content: string;
  citations?: ShareChatCitation[];
  error?: boolean;
}

const MOBILE_SHEET_QUERY = "(max-width: 639.98px)";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7.5L7 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z" strokeLinejoin="round" />
      <path d="M8 10.5h8M8 13h5" strokeLinecap="round" />
    </svg>
  );
}

export function ShareChatWidget({ token, title }: { token: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const titleId = useId();
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    // 닫은 뒤 원형 버튼으로 초점을 돌린다.
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function onKey(e: globalThis.KeyboardEvent) {
      // 한글 조합 중 Esc는 조합 취소다.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // 휴대폰 시트가 열려 있는 동안: 페이지(같은 부모의 다른 요소)를 inert로 만들고 body 스크롤을 잠근다. 화면 폭이 바뀌면 다시 맞춘다.
  useEffect(() => {
    const layer = layerRef.current;
    if (!open || !layer?.parentElement) return;
    const mq = window.matchMedia(MOBILE_SHEET_QUERY);
    const siblings = [...layer.parentElement.children].filter((el): el is HTMLElement => el !== layer && el instanceof HTMLElement);
    const prevOverflow = document.body.style.overflow;
    let applied = false;
    const release = () => {
      if (!applied) return;
      applied = false;
      for (const el of siblings) el.inert = false;
      document.body.style.overflow = prevOverflow;
    };
    const apply = () => {
      if (!mq.matches) return release();
      if (applied) return;
      applied = true;
      for (const el of siblings) el.inert = true;
      document.body.style.overflow = "hidden";
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      release();
    };
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending, open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function ask(raw: string) {
    const question = raw.trim().slice(0, SHARE_CHAT_MAX_QUESTION_CHARS);
    if (!question || sending) return;
    const history = messages
      .filter((m) => !m.error)
      .slice(-SHARE_CHAT_MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, SHARE_CHAT_MAX_HISTORY_MESSAGE_CHARS) }));
    setMessages((cur) => [...cur, { role: "user", content: question }]);
    setDraft("");
    setSending(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/p/${encodeURIComponent(token)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => null)) as (ShareChatResponse & { error?: string }) | null;
      if (!res.ok || !data || typeof data.answer !== "string") {
        const msg =
          res.status === 404
            ? "이 포트폴리오의 챗봇을 더 이상 쓸 수 없습니다. 작성자가 공개를 끄거나 챗봇을 껐을 수 있습니다."
            : (data?.error ?? "답을 받지 못했습니다. 잠시 후 다시 물어봐 주세요.");
        setMessages((cur) => [...cur, { role: "assistant", content: msg, error: true }]);
        return;
      }
      setMessages((cur) => [...cur, { role: "assistant", content: data.answer, citations: data.citations }]);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setMessages((cur) => [...cur, { role: "assistant", content: "서버에 연결하지 못했습니다. 잠시 후 다시 물어봐 주세요.", error: true }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  function onInputKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(draft);
    }
  }

  return (
    <>
      {!open && (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="포트폴리오에 대해 질문하기"
          aria-haspopup="dialog"
          aria-expanded={false}
          title="포트폴리오에 대해 질문하기"
          className="fixed z-40 inline-flex size-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg ring-1 ring-indigo-700/20 transition hover:bg-indigo-700 focus-visible:ring-4 focus-visible:ring-indigo-300 focus-visible:outline-none print:hidden"
          style={{ right: "calc(1.25rem + env(safe-area-inset-right))", bottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}
        >
          <ChatIcon className="size-7" />
        </button>
      )}
      {open && (
        <div ref={layerRef}>
          {/* 휴대폰 시트 뒤 배경: 페이지를 가리고 누르면 닫는다(넓은 화면에서는 없다). */}
          <div aria-hidden className="fixed inset-0 z-50 bg-slate-900/40 sm:hidden print:hidden" onClick={close} />
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={cn(
              "fixed z-50 flex flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl print:hidden",
              // 640px 이하: 화면 아래 전체 폭 시트(홈 표시줄만큼 안쪽 여백). 그 위: 오른쪽 아래 패널(safe-area만큼 띄운다).
              "max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-[85dvh] max-sm:rounded-t-2xl max-sm:pb-[env(safe-area-inset-bottom)]",
              "sm:right-[calc(1.25rem_+_env(safe-area-inset-right))] sm:bottom-[calc(1.25rem_+_env(safe-area-inset-bottom))] sm:h-[min(36rem,calc(100dvh_-_3rem))] sm:w-[24rem] sm:rounded-2xl",
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <h2 id={titleId} className="font-semibold text-slate-900">
                  포트폴리오에 질문하기
                </h2>
                <p className="mt-0.5 truncate text-xs text-slate-500">{title}</p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="챗봇 닫기"
                className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              >
                <span aria-hidden className="text-lg leading-none">
                  ×
                </span>
              </button>
            </header>

            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite" aria-busy={sending}>
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                {SHARE_CHAT_DISCLAIMER}. 포트폴리오에 없는 내용은 답하지 않으며, 대화는 저장되지 않습니다.
              </p>
              {messages.length === 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-slate-500">이런 질문을 해 보세요</p>
                  <div className="flex flex-wrap gap-1.5">
                    {SHARE_CHAT_STARTERS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => void ask(q)}
                        disabled={sending}
                        className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-left text-xs text-indigo-700 hover:border-indigo-300 hover:bg-indigo-100"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                      m.role === "user" ? "bg-indigo-600 text-white" : m.error ? "bg-amber-50 text-amber-900" : "bg-slate-100 text-slate-800",
                    )}
                  >
                    <span className="sr-only">{m.role === "user" ? "내 질문: " : "챗봇 답: "}</span>
                    {m.content}
                    {m.citations && m.citations.length > 0 && (
                      <p className="mt-1.5 text-xs text-slate-500">근거: {m.citations.map((c) => c.label).join(" · ")}</p>
                    )}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Spinner className="size-3.5" /> 답을 쓰는 중…
                </div>
              )}
            </div>

            <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-slate-200 px-3 py-3">
              <label htmlFor={`${panelId}-input`} className="sr-only">
                질문
              </label>
              <textarea
                ref={inputRef}
                id={`${panelId}-input`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onInputKey}
                rows={2}
                maxLength={SHARE_CHAT_MAX_QUESTION_CHARS}
                placeholder="이 포트폴리오에 대해 물어보세요"
                className="min-h-[2.75rem] flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                보내기
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
