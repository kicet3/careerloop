import type { ReactNode } from "react";
import { LEVEL_LABELS } from "@/lib/report/model";
import type { ReportModel } from "@/lib/report/types";
import { BulletList, Card, EmptyState, SubHeading, cx } from "./primitives";

type Level = "high" | "medium" | "low";

const IMPACT_STYLE: Record<Level, string> = {
  high: "bg-indigo-600 text-white",
  medium: "bg-indigo-100 text-indigo-800",
  low: "bg-slate-100 text-slate-600",
};

// 노력은 낮을수록 좋다.
const EFFORT_STYLE: Record<Level, string> = {
  low: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20",
  medium: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-600/20",
  high: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20",
};

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <SubHeading>{title}</SubHeading>
      {children}
    </div>
  );
}

export function ImprovementPlanSection({ report }: { report: ReportModel }) {
  const p = report.plan;
  if (!p) return <EmptyState>개선 방향성이 아직 완료되지 않았습니다.</EmptyState>;
  const reqText = new Map(report.jd?.rows.map((r) => [r.requirement.id, r.requirement.text]) ?? []);

  return (
    <div className="space-y-8">
      <div className="break-inside-avoid rounded-xl bg-indigo-600 p-6 text-white print:border print:border-indigo-600 print:bg-white print:text-slate-900">
        <p className="text-xs font-semibold tracking-widest text-indigo-200 print:text-indigo-600">가장 중요한 방향 전환</p>
        <p className="mt-2 text-lg font-semibold leading-relaxed">{p.headline}</p>
      </div>

      <Block title="포지셔닝">
        <p className="whitespace-pre-line text-sm leading-7 text-slate-700">{p.positioning}</p>
      </Block>

      {p.priorities.length > 0 && (
        <Block title="우선순위 액션">
          <ol className="grid gap-3 md:grid-cols-2">
            {p.priorities.map((x, i) => (
              <li key={i} className="flex break-inside-avoid flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm print:shadow-none">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-sm font-bold tabular-nums text-indigo-600">{String(i + 1).padStart(2, "0")}</span>
                  <h4 className="font-semibold leading-snug text-slate-900">{x.title}</h4>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className={cx("rounded px-2 py-0.5 text-[11px] font-semibold", IMPACT_STYLE[x.impact])}>
                    임팩트 {LEVEL_LABELS[x.impact]}
                  </span>
                  <span className={cx("rounded px-2 py-0.5 text-[11px] font-semibold", EFFORT_STYLE[x.effort])}>
                    노력 {LEVEL_LABELS[x.effort]}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">{x.why}</p>
                <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-sm text-slate-800">
                  {x.actions.map((a, j) => (
                    <li key={j} className="flex gap-2">
                      <span aria-hidden className="text-indigo-500">→</span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </Block>
      )}

      {p.quickWins.length > 0 && (
        <Card className="bg-emerald-50/40">
          <SubHeading>오늘 할 퀵윈 (30분 이내)</SubHeading>
          <ul className="space-y-2">
            {p.quickWins.map((x, i) => (
              <li key={i} className="flex gap-3 text-sm leading-relaxed text-slate-800">
                <span aria-hidden className="mt-0.5 h-4 w-4 shrink-0 rounded border-2 border-emerald-500 bg-white" />
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {p.sectionGuidance.length > 0 && (
        <Block title="섹션별 가이드">
          <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {p.sectionGuidance.map((g, i) => (
              <div key={i} className="grid break-inside-avoid gap-1 px-5 py-3.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
                <dt className="text-sm font-semibold text-slate-900">{g.section}</dt>
                <dd className="text-sm leading-relaxed text-slate-700">{g.direction}</dd>
              </div>
            ))}
          </dl>
        </Block>
      )}

      {p.skillGaps.length > 0 && (
        <Block title="역량 공백과 메우는 법">
          <p className="-mt-1 mb-3 text-xs text-slate-500">이력서 문장만으로는 메울 수 없는 실제 공백입니다.</p>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5">역량</th>
                  <th scope="col" className="px-4 py-2.5">메우는 법</th>
                  <th scope="col" className="w-24 px-4 py-2.5">기간</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {p.skillGaps.map((g, i) => (
                  <tr key={i} className="break-inside-avoid align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{g.skill}</p>
                      {g.requirementId && (
                        <p className="mt-0.5 text-xs text-slate-500">
                          <span className="font-mono">{g.requirementId}</span>
                          {reqText.get(g.requirementId) ? ` · ${reqText.get(g.requirementId)}` : ""}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 leading-relaxed text-slate-700">{g.howToClose}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-900">{g.timeframe}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      {p.applicationStrategy.length > 0 && (
        <Block title="지원 전략">
          <BulletList items={p.applicationStrategy} />
        </Block>
      )}

      {p.interviewPrep.length > 0 && (
        <Block title="면접 대비">
          <div className="space-y-3">
            {p.interviewPrep.map((q, i) => (
              <div key={i} className="break-inside-avoid rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-900">
                  <span className="mr-2 text-indigo-600">Q.</span>
                  {q.question}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  <span className="mr-2 font-semibold text-slate-400">A.</span>
                  {q.angle}
                </p>
              </div>
            ))}
          </div>
        </Block>
      )}
    </div>
  );
}
