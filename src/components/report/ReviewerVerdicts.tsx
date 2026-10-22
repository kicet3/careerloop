import { REVIEWER_IDS } from "@/lib/domain/schemas";
import { REVIEWERS } from "@/lib/domain/reviewers";
import { PENDING_VERDICT } from "@/lib/report/model";
import type { ReviewerCard } from "@/lib/report/types";
import { TONE_DOT, VerdictBadge, cx } from "./primitives";

/** 심사위원 7명의 한 줄 평. 아직 결과가 없는 심사위원도 '미완료'로 자리를 지킨다. */
export function ReviewerVerdicts({ reviewers }: { reviewers: ReviewerCard[] }) {
  const byId = new Map(reviewers.map((r) => [r.id, r]));
  return (
    <ol className="grid gap-3 sm:grid-cols-2">
      {REVIEWER_IDS.map((id, i) => {
        const card = byId.get(id);
        const meta = REVIEWERS[id];
        const verdict = card?.verdict ?? PENDING_VERDICT;
        return (
          <li
            key={id}
            className={cx(
              "relative flex break-inside-avoid flex-col gap-2 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 pl-5 shadow-sm print:shadow-none",
              !card && "opacity-60",
            )}
          >
            <span aria-hidden className={cx("absolute inset-y-0 left-0 w-1", card ? TONE_DOT[verdict.tone] : "bg-slate-200")} />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  <span className="mr-1.5 tabular-nums text-slate-400">{i + 1}</span>
                  {meta.name}
                </p>
                <p className="mt-0.5 text-xs leading-snug text-slate-500">{meta.role}</p>
              </div>
              <VerdictBadge verdict={verdict} />
            </div>
            <p className="text-sm leading-relaxed text-slate-700">
              {card ? card.oneLiner : "이 심사위원의 결과가 아직 없습니다."}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
