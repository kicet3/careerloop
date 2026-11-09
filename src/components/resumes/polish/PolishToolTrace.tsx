import { POLISH_TOOL_LABELS, type PolishToolUse, polishToolSummary } from "@/lib/domain/resume-polish";

const STATUS_TEXT: Record<PolishToolUse["status"], string> = { ok: "", empty: "결과 없음", error: "실패" };

/** 답변 하나에서 AI가 조회한 자료(접을 수 있는 한 줄). 성공한 호출이 없으면 그리지 않는다. 원문 데이터는 저장·표시하지 않는다. */
export function PolishToolTrace({ tools }: { tools: readonly PolishToolUse[] | undefined }) {
  const summary = polishToolSummary(tools);
  if (!summary || !tools) return null;
  return (
    <details className="text-[11px] text-slate-500">
      <summary className="cursor-pointer select-none">참고한 자료: {summary}</summary>
      <ul className="mt-1 space-y-0.5 pl-3">
        {tools.map((t, i) => (
          <li key={i}>
            {POLISH_TOOL_LABELS[t.tool]}
            {t.status === "ok" ? (t.tool === "get_jd_analysis" ? "" : ` · ${t.items}건`) : ` · ${STATUS_TEXT[t.status]}`}
          </li>
        ))}
      </ul>
    </details>
  );
}
