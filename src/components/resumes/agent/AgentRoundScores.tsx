/**
 * 라운드별 심사 점수표: 라운드 × 핵심 심사 3명 판정 칩 + 적합도 + 라운드 점수, 목표선(ATS 통과·핵심 2/3·적합도 75). 최종 행에 7명 결과.
 * 심사위원 이름·판정 라벨은 domain/reviewers(REVIEWERS·verdictLabel)를 쓴다 — 리더의 PASS는 '거절'로 보인다.
 */
import { Badge } from "@/components/ui/Badge";
import { REVIEWERS, verdictLabel } from "@/lib/domain/reviewers";
import type { ReviewerId } from "@/lib/domain/schemas";
import { AGENT_TARGETS, type FinalPanelView, type RoundScoreView } from "@/lib/resume-agent/job-types";

const toneOf = (t: "positive" | "neutral" | "negative") => (t === "positive" ? "positive" : t === "negative" ? "negative" : "warning");

export function roundTitle(round: number): string {
  return round === 0 ? "첫 초안" : `수정 ${round}회차`;
}

/** 심사위원 한 줄 평(진단과 같은 '이름: 한 줄 평'). 심사 못 한 자리표시는 뺀다. collapsed면 접어 둔다(라운드 행). */
function OneLiners({ verdicts, collapsed }: { verdicts: readonly { reviewer: ReviewerId; verdict: string | null; oneLiner: string }[]; collapsed?: boolean }) {
  const items = verdicts.filter((v) => v.verdict && v.oneLiner.trim() && v.oneLiner !== "심사 못 함");
  if (items.length === 0) return null;
  const list = (
    <ul className="mt-1.5 grid gap-0.5 text-xs text-slate-600">
      {items.map((v) => (
        <li key={v.reviewer}>
          <span className="font-medium text-slate-700">{REVIEWERS[v.reviewer].name}</span>: {v.oneLiner}
        </li>
      ))}
    </ul>
  );
  if (!collapsed) return list;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-slate-500">한 줄 평 보기</summary>
      {list}
    </details>
  );
}

export function AgentRoundScores({ rounds, finalPanel, chosenRound }: { rounds: RoundScoreView[]; finalPanel: FinalPanelView | null; chosenRound?: number | null }) {
  if (rounds.length === 0 && !finalPanel) return null;
  return (
    <section aria-label="라운드별 심사 점수" className="grid gap-2">
      <p className="text-xs text-slate-500">
        목표: ATS 통과 · 핵심 심사 {AGENT_TARGETS.minCorePass}/{AGENT_TARGETS.coreTotal} 이상 · 적합도 {AGENT_TARGETS.minMatchScore} 이상
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">라운드</th>
              <th className="py-1.5 pr-3 font-medium">심사위원 판정</th>
              <th className="py-1.5 pr-3 font-medium">통과</th>
              <th className="py-1.5 pr-3 font-medium">적합도</th>
              <th className="py-1.5 font-medium">점수</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rounds.map((r) => (
              <tr key={r.round} className={r.round === chosenRound ? "bg-indigo-50/50" : undefined}>
                <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                  {roundTitle(r.round)}
                  {r.round === chosenRound && <span className="ml-1 text-xs text-indigo-700">(최종본)</span>}
                </td>
                <td className="py-2 pr-3">
                  <span className="flex flex-wrap gap-1">
                    {r.verdicts.map((v) => {
                      const l = verdictLabel(v.reviewer, v.verdict);
                      return (
                        <Badge key={v.reviewer} tone={toneOf(l.tone)}>
                          {REVIEWERS[v.reviewer].name} {l.label}
                        </Badge>
                      );
                    })}
                    {r.incomplete && <Badge tone="neutral">일부 심사 못 함</Badge>}
                  </span>
                  <OneLiners verdicts={r.verdicts} collapsed />
                </td>
                <td className="py-2 pr-3 tabular-nums">
                  {r.passCount}/{r.passTotal}
                </td>
                <td className={`py-2 pr-3 tabular-nums ${r.matchScore >= AGENT_TARGETS.minMatchScore ? "text-emerald-700" : "text-slate-700"}`}>{r.matchScore}</td>
                <td className="py-2 font-semibold tabular-nums text-slate-900">{r.panelScore}</td>
              </tr>
            ))}
            {finalPanel && (
              <tr>
                <td className="py-2 pr-3 whitespace-nowrap font-medium text-slate-900">최종 심사</td>
                <td className="py-2 pr-3" colSpan={4}>
                  <span className="flex flex-wrap items-center gap-1">
                    <span className="mr-1 font-semibold text-slate-900">
                      심사위원 7명 중 {finalPanel.passCount}명 통과
                    </span>
                    {finalPanel.verdicts.map((v) => {
                      if (!v.verdict) return <Badge key={v.reviewer}>{REVIEWERS[v.reviewer].name} 심사 못 함</Badge>;
                      const l = verdictLabel(v.reviewer, v.verdict);
                      return (
                        <Badge key={v.reviewer} tone={toneOf(l.tone)}>
                          {REVIEWERS[v.reviewer].name} {l.label}
                        </Badge>
                      );
                    })}
                  </span>
                  <OneLiners verdicts={finalPanel.verdicts} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
