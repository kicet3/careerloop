"use client";

/**
 * 보고서의 심사위원 카드에 붙는 '이 심사위원과 대화' 버튼과 시트.
 * 모바일은 화면 전체, sm 이상은 오른쪽 패널로 연다. 공유 화면에서는 렌더하지 않는다(Report의 reviewerChat 옵션).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { REVIEWERS } from "@/lib/domain/reviewers";
import type { ReviewerId } from "@/lib/domain/schemas";
import { josa, ReviewerChatPanel, type ReviewerChatActivity } from "./ReviewerChatPanel";

export function ReviewerChatButton({
  diagnosisId,
  reviewer,
  className,
}: {
  diagnosisId: string;
  reviewer: ReviewerId;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-sm font-medium whitespace-nowrap text-indigo-700 transition-colors hover:border-indigo-300 hover:bg-indigo-100 print:hidden",
          className,
        )}
      >
        <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4">
          <path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
        </svg>
        이 심사위원과 대화
      </button>
      {open && <ReviewerChatSheet diagnosisId={diagnosisId} reviewer={reviewer} onClose={close} />}
    </>
  );
}

function ReviewerChatSheet({
  diagnosisId,
  reviewer,
  onClose,
}: {
  diagnosisId: string;
  reviewer: ReviewerId;
  onClose: () => void;
}) {
  const meta = REVIEWERS[reviewer];
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // 패널이 알려 주는 현재 상태(답변 대기·입력 중 글). 닫기 전에 확인한다.
  const activityRef = useRef<ReviewerChatActivity>({ sending: false, draft: "" });
  const onActivity = useCallback((a: ReviewerChatActivity) => {
    activityRef.current = a;
  }, []);

  /** 답변을 기다리는 중이거나 입력 중인 글이 있으면 확인한 뒤 닫는다(닫으면 요청이 취소되고 질문·답변이 저장되지 않는다). */
  const requestClose = useCallback(() => {
    const { sending, draft } = activityRef.current;
    if (sending && !window.confirm("답변을 기다리는 중입니다. 지금 닫으면 이번 질문과 답변이 저장되지 않습니다. 닫을까요?")) return;
    if (!sending && draft.trim() && !window.confirm("입력 중인 메시지가 사라집니다. 닫을까요?")) return;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    function onKey(e: globalThis.KeyboardEvent) {
      // 한글 조합 중 ESC는 조합 취소다 — 시트를 닫지 않는다.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
        return;
      }
      // aria-modal 시트: Tab 포커스를 안에 가둔다(가려진 보고서로 빠져나가지 않게).
      const panel = dialogRef.current;
      if (e.key !== "Tab" || !panel) return;
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [requestClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end print:hidden">
      <div className="absolute inset-0 bg-slate-900/40" aria-hidden onClick={requestClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-dvh w-full flex-col bg-white shadow-xl focus:outline-none sm:max-w-lg sm:border-l sm:border-slate-200"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="font-semibold text-slate-900">
              {josa(meta.name, "과", "와")} 대화
            </h2>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">{meta.role}</p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="대화 닫기"
            className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <span aria-hidden className="text-lg leading-none">
              ×
            </span>
          </button>
        </header>
        <ReviewerChatPanel diagnosisId={diagnosisId} reviewer={reviewer} onActivity={onActivity} />
      </div>
    </div>,
    document.body,
  );
}
