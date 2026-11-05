"use client";
/**
 * 공고 화면 공용 조각: 마감·상태 배지, 입력 스타일, 현재 시각 훅, API 오류 읽기.
 */
import { useEffect, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { POSTING_STATUS_LABELS, type JobPosting, type PostingStatus } from "@/lib/domain/postings";
import { deadlineInfo, type DeadlineLevel } from "@/lib/postings/deadline";

export const inputClass =
  "mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";
export const textareaClass = `${inputClass} resize-y leading-relaxed`;
export const labelClass = "block text-sm font-medium text-slate-800";

const DEADLINE_TONES: Record<DeadlineLevel, BadgeTone> = {
  urgent: "negative",
  soon: "warning",
  safe: "info",
  past: "neutral",
  none: "neutral",
};

export function DeadlineBadge({ posting, now }: { posting: Pick<JobPosting, "deadline" | "deadlineTime" | "deadlineKind">; now: number }) {
  const info = deadlineInfo(posting, now);
  return <Badge tone={DEADLINE_TONES[info.level]}>{info.label}</Badge>;
}

const STATUS_TONES: Record<PostingStatus, BadgeTone> = {
  saved: "neutral",
  reviewing: "info",
  planned: "accent",
  applied: "positive",
  on_hold: "warning",
  closed: "neutral",
};

export function PostingStatusBadge({ status }: { status: PostingStatus }) {
  return <Badge tone={STATUS_TONES[status]}>{POSTING_STATUS_LABELS[status]}</Badge>;
}

/**
 * 현재 시각(1분마다 갱신). 첫 렌더는 서버가 준 시각을 써서 서버·브라우저 결과가 같게 한다(하이드레이션 불일치 방지).
 */
export function useNow(serverNow: number): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);
  return now;
}

export type ApiError = { error: string; existingId?: string };

/** 응답 본문의 { error, existingId }. 없으면 기본 문구. */
export async function readApiError(res: Response, fallback: string): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { error?: unknown; existingId?: unknown } | null;
  return {
    error: typeof data?.error === "string" ? data.error : fallback,
    existingId: typeof data?.existingId === "string" ? data.existingId : undefined,
  };
}
