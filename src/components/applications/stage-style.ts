/** 지원 단계별 색(배지 톤·칸반 열 점). 진행은 indigo/sky, 합격은 초록, 종료는 회색·빨강. */
import type { BadgeTone } from "@/components/ui/Badge";
import type { ApplicationStage } from "@/lib/domain/applications";

export const STAGE_TONE: Record<ApplicationStage, BadgeTone> = {
  interested: "neutral",
  applied: "accent",
  assignment: "info",
  interview: "info",
  offer: "positive",
  rejected: "negative",
  withdrawn: "neutral",
};

export const STAGE_DOT: Record<ApplicationStage, string> = {
  interested: "bg-slate-400",
  applied: "bg-indigo-500",
  assignment: "bg-sky-500",
  interview: "bg-sky-600",
  offer: "bg-emerald-500",
  rejected: "bg-red-400",
  withdrawn: "bg-slate-300",
};

/** 0~1 비율 → "33%". null이면 "–". */
export const percent = (rate: number | null) => (rate === null ? "–" : `${Math.round(rate * 100)}%`);
