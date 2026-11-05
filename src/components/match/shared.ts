/** 대조 화면 공용(클라이언트): API 호출·상태 색·그래프 채팅 링크. */
import type { BadgeTone } from "@/components/ui";
import type { MatchStatus, RequirementImportance } from "@/lib/graph/match";

export class MatchApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new MatchApiError(data?.error ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", res.status);
  return data as T;
}

/** 증명됨 초록 / 보유만 노랑 / 없음 회색. */
export const STATUS_STYLE: Record<MatchStatus, { chip: string; dot: string; bar: string }> = {
  proven: { chip: "border-emerald-200 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500", bar: "bg-emerald-500" },
  claimed: { chip: "border-amber-200 bg-amber-50 text-amber-900", dot: "bg-amber-400", bar: "bg-amber-400" },
  missing: { chip: "border-slate-200 bg-slate-50 text-slate-600", dot: "bg-slate-300", bar: "bg-slate-300" },
};

export const IMPORTANCE_TONE: Record<RequirementImportance, BadgeTone> = { must: "accent", nice: "info", keyword: "neutral" };

export { graphChatHref } from "@/components/graph/api";
