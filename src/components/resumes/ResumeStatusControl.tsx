"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  GENERAL_RESUME_STATUS_LABEL,
  RESUME_APPLY_STATUS_LABELS,
  RESUME_APPLY_STATUSES,
  type ResumeApplyStatus,
  type ResumeKind,
} from "@/lib/domain/resumes";
import type { ChangeResumeStatusResult } from "@/lib/resumes/types";

export const RESUME_STATUS_TONE: Record<ResumeApplyStatus, BadgeTone> = {
  draft: "neutral",
  applying: "info",
  submitted: "positive",
};

/** 지원 상태 배지. 공용 이력서는 '공용'. */
export function ResumeStatusBadge({ kind, status }: { kind: ResumeKind; status: ResumeApplyStatus | null }) {
  if (kind === "general" || !status) return <Badge tone="accent">{GENERAL_RESUME_STATUS_LABEL}</Badge>;
  return <Badge tone={RESUME_STATUS_TONE[status]}>{RESUME_APPLY_STATUS_LABELS[status]}</Badge>;
}

type RevertApplication = "keep" | "withdraw" | "delete";

/** '지원 완료'로 바꾼 뒤 보여 줄 안내. */
export function submittedNotice(result: ChangeResumeStatusResult, hasPosting: boolean): string {
  if (!hasPosting) return "지원 완료로 바꿨습니다. 연결된 공고가 없어 지원 기록은 만들지 않았습니다.";
  if (!result.application) return "지원 완료로 바꿨습니다.";
  return result.application.created
    ? "지원 완료로 바꾸고 공고를 '지원함'으로 두었습니다. 지금 버전을 제출본으로 고정한 지원 기록을 만들었습니다."
    : "지원 완료로 바꾸고 이 공고의 기존 지원 기록에 연결했습니다.";
}

const SELECT_TONE: Record<ResumeApplyStatus, string> = {
  draft: "border-slate-300 bg-slate-50 text-slate-700",
  applying: "border-sky-200 bg-sky-50 text-sky-800",
  submitted: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

/**
 * 지원 상태 빠른 변경(지원 전·지원 중·지원 완료). 공용 이력서는 '공용' 배지만 보인다.
 * '지원 완료'에서 다른 상태로 되돌릴 때는 확인 창에서 공고 상태·지원 기록을 어떻게 할지 고른다.
 */
export function ResumeStatusControl({
  resumeId,
  kind,
  status,
  hasPosting,
  hasApplication,
  onChanged,
  beforeSubmit,
  size = "md",
  className,
}: {
  resumeId: string;
  kind: ResumeKind;
  status: ResumeApplyStatus | null;
  /** 연결 공고가 있는지(되돌리기 확인 창의 공고 옵션). */
  hasPosting: boolean;
  /** '지원 완료' 때 연결한 지원 기록이 있는지(되돌리기 확인 창의 지원 기록 옵션). */
  hasApplication: boolean;
  onChanged: (result: ChangeResumeStatusResult, message: string) => void;
  /**
   * '지원 완료'로 바꾸기 직전에 부른다(편집 화면: 저장하지 않은 변경이 있으면 먼저 저장할지 묻는다).
   * false면 바꾸지 않는다. 서버는 마지막으로 저장한 버전을 제출본으로 고정한다.
   */
  beforeSubmit?: () => Promise<boolean>;
  size?: "sm" | "md";
  className?: string;
}) {
  const selectId = useId();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertTo, setRevertTo] = useState<ResumeApplyStatus | null>(null);
  const [revertPosting, setRevertPosting] = useState(true);
  const [revertApplication, setRevertApplication] = useState<RevertApplication>("keep");

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (revertTo && !d.open) d.showModal();
    if (!revertTo && d.open) d.close();
  }, [revertTo]);

  if (kind === "general" || !status) return <ResumeStatusBadge kind={kind} status={null} />;

  async function send(next: ResumeApplyStatus, opts: { revertPosting?: boolean; revertApplication?: RevertApplication } = {}) {
    setError(null);
    setPending(true);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, ...opts }),
      });
      const data = (await res.json().catch(() => null)) as (ChangeResumeStatusResult & { error?: string }) | null;
      if (!res.ok || !data?.resume) {
        setError(data?.error ?? (res.status === 409 ? "다른 곳에서 먼저 바꿨습니다. 새로고침해 주세요." : "상태를 바꾸지 못했습니다."));
        return false;
      }
      const message =
        next === "submitted"
          ? submittedNotice(data, hasPosting)
          : status === "submitted"
            ? `${RESUME_APPLY_STATUS_LABELS[next]}(으)로 되돌렸습니다.`
            : `${RESUME_APPLY_STATUS_LABELS[next]}(으)로 바꿨습니다.`;
      onChanged(data, message);
      return true;
    } catch {
      setError("서버에 연결하지 못했습니다.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function pick(next: ResumeApplyStatus) {
    if (next === status) return;
    if (next === "submitted" && beforeSubmit) {
      setPending(true);
      let ok = false;
      try {
        ok = await beforeSubmit();
      } finally {
        setPending(false);
      }
      if (!ok) return;
    }
    if (status === "submitted") {
      // 되돌리기는 확인을 받는다.
      setRevertPosting(hasPosting);
      setRevertApplication("keep");
      setRevertTo(next);
      return;
    }
    void send(next);
  }

  async function confirmRevert() {
    if (!revertTo) return;
    const ok = await send(revertTo, { revertPosting: hasPosting && revertPosting, revertApplication: hasApplication ? revertApplication : "keep" });
    if (ok) setRevertTo(null);
  }

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <label htmlFor={selectId} className="sr-only">
        지원 상태
      </label>
      <select
        id={selectId}
        value={status}
        disabled={pending}
        onChange={(e) => void pick(e.target.value as ResumeApplyStatus)}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "rounded-full border font-medium focus:ring-2 focus:ring-indigo-500/30 focus:outline-none disabled:opacity-60",
          size === "sm" ? "py-0.5 pr-6 pl-2 text-xs" : "py-1 pr-7 pl-2.5 text-sm",
          SELECT_TONE[status],
        )}
        title="지원 상태 바꾸기"
      >
        {RESUME_APPLY_STATUSES.map((s) => (
          <option key={s} value={s}>
            {RESUME_APPLY_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {pending && <span className="text-xs text-slate-500">바꾸는 중…</span>}
      {error && !revertTo && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          if (!pending) setRevertTo(null);
        }}
        className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
      >
        <div className="space-y-4 p-5 text-sm text-slate-700">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            &lsquo;지원 완료&rsquo;를 {revertTo ? `'${RESUME_APPLY_STATUS_LABELS[revertTo]}'` : ""}(으)로 되돌릴까요?
          </h2>
          <p>이력서의 지원 상태만 바뀝니다. 연결된 공고와 지원 기록은 아래에서 고른 대로 처리합니다.</p>
          {hasPosting && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={revertPosting}
                onChange={(e) => setRevertPosting(e.target.checked)}
                className="mt-0.5 size-4 rounded border-slate-300 text-indigo-600"
              />
              <span>
                공고 상태도 &lsquo;지원 예정&rsquo;으로 되돌리기
                <span className="block text-xs text-slate-500">지금 &lsquo;지원함&rsquo;일 때만 바뀝니다.</span>
              </span>
            </label>
          )}
          {hasApplication && (
            <fieldset className="space-y-1.5">
              <legend className="font-medium text-slate-800">연결된 지원 기록</legend>
              {(
                [
                  ["keep", "그대로 두기", "지원 현황에 기록과 제출본이 남습니다."],
                  ["withdraw", "'지원 취소'로 바꾸기", "기록은 남기고 단계만 지원 취소로 둡니다."],
                  ["delete", "지원 기록 삭제", "기록과 고정한 제출본이 사라지며 되돌릴 수 없습니다."],
                ] as const
              ).map(([value, label, hint]) => (
                <label key={value} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`${titleId}-app`}
                    value={value}
                    checked={revertApplication === value}
                    onChange={() => setRevertApplication(value)}
                    className="mt-0.5 size-4 border-slate-300 text-indigo-600"
                  />
                  <span>
                    <span className={value === "delete" ? "text-red-700" : undefined}>{label}</span>
                    <span className="block text-xs text-slate-500">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setRevertTo(null)} disabled={pending}>
              취소
            </Button>
            <Button
              variant={hasApplication && revertApplication === "delete" ? "danger" : "primary"}
              size="sm"
              onClick={confirmRevert}
              loading={pending}
            >
              되돌리기
            </Button>
          </div>
        </div>
      </dialog>
    </span>
  );
}
