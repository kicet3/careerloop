/** 그래프 화면 공용 스타일(라벨별 색 — Tailwind가 찾을 수 있게 클래스 이름은 문자열 그대로 둔다). */
import type { EndpointLabel } from "@/lib/domain/graph";

export const LABEL_STYLE: Record<EndpointLabel, { node: string; chip: string; dot: string }> = {
  Person: { node: "fill-indigo-600 stroke-indigo-700", chip: "bg-indigo-600 text-white ring-indigo-600", dot: "bg-indigo-600" },
  Company: { node: "fill-indigo-100 stroke-indigo-500", chip: "bg-indigo-50 text-indigo-700 ring-indigo-200", dot: "bg-indigo-500" },
  Role: { node: "fill-sky-100 stroke-sky-500", chip: "bg-sky-50 text-sky-700 ring-sky-200", dot: "bg-sky-500" },
  Project: { node: "fill-violet-100 stroke-violet-500", chip: "bg-violet-50 text-violet-700 ring-violet-200", dot: "bg-violet-500" },
  Experience: { node: "fill-amber-100 stroke-amber-500", chip: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500" },
  Skill: { node: "fill-emerald-100 stroke-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", dot: "bg-emerald-500" },
  Achievement: { node: "fill-rose-100 stroke-rose-500", chip: "bg-rose-50 text-rose-700 ring-rose-200", dot: "bg-rose-500" },
  Education: { node: "fill-teal-100 stroke-teal-500", chip: "bg-teal-50 text-teal-700 ring-teal-200", dot: "bg-teal-500" },
  Certification: { node: "fill-orange-100 stroke-orange-500", chip: "bg-orange-50 text-orange-700 ring-orange-200", dot: "bg-orange-500" },
};

export const inputClass =
  "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";
export const textareaClass = `${inputClass} resize-y leading-relaxed`;
export const labelClass = "block text-sm font-medium text-slate-700";
