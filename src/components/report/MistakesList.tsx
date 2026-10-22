import type { Mistake } from "@/lib/domain/schemas";
import { SEVERITY_LABELS } from "@/lib/report/model";
import type { MistakeView } from "@/lib/report/types";
import { EmptyState, QuoteBlock, cx } from "./primitives";

const SEVERITY_STYLE: Record<Mistake["severity"], { badge: string; rank: string }> = {
  critical: { badge: "bg-rose-600 text-white", rank: "bg-rose-50 text-rose-700 ring-rose-600/20" },
  major: { badge: "bg-amber-500 text-white", rank: "bg-amber-50 text-amber-800 ring-amber-600/20" },
  minor: { badge: "bg-slate-200 text-slate-700", rank: "bg-slate-50 text-slate-600 ring-slate-500/20" },
};

export function MistakesList({ mistakes }: { mistakes: MistakeView[] }) {
  if (!mistakes.length) return <EmptyState>문제점 종합이 아직 완료되지 않았습니다.</EmptyState>;
  return (
    <ol className="space-y-4">
      {mistakes.map((m, i) => {
        const s = SEVERITY_STYLE[m.severity];
        return (
          <li key={i} className="break-inside-avoid rounded-xl border border-slate-200 bg-white p-5 shadow-sm print:shadow-none">
            <div className="flex gap-4">
              <span
                className={cx(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums ring-1 ring-inset",
                  s.rank,
                )}
              >
                {/* 변경 내역·개선 방향성이 "#N"으로 가리키는 번호와 같도록 rank를 그대로 쓴다. */}
                {m.rank}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-bold", s.badge)}>{SEVERITY_LABELS[m.severity]}</span>
                  <h3 className="text-base font-semibold leading-snug text-slate-900">{m.title}</h3>
                </div>
                {m.quote ? (
                  <QuoteBlock quote={m.quote} className="mt-3" />
                ) : (
                  <p className="mt-3 text-xs text-slate-500">이력서 전체에 걸친 문제</p>
                )}
                <dl className="mt-3 grid gap-3 text-sm leading-relaxed sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold text-slate-500">왜 떨어지나</dt>
                    <dd className="mt-0.5 text-slate-700">{m.why}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold text-indigo-700">고칠 방향</dt>
                    <dd className="mt-0.5 text-slate-800">{m.fix}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-400">지적</span>
                  {m.flaggedBy.map((f) => (
                    <span key={f.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                      {f.name}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
