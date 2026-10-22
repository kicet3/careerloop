import { verdictLabel } from "@/lib/domain/reviewers";
import type { ReportModel } from "@/lib/report/types";
import { MiniMarkdown, renderInline } from "./MiniMarkdown";
import { BulletList, Chip, EmptyState, SubHeading, VerdictBadge } from "./primitives";

export function RewriteSection({ report }: { report: ReportModel }) {
  const rw = report.rewrite;
  if (!rw) return <EmptyState>이력서 재작성이 아직 완료되지 않았습니다.</EmptyState>;
  const rescreen = rw.rescreen;
  const after = rescreen ? { raw: rescreen.verdict, ...verdictLabel("ats", rescreen.verdict) } : null;

  return (
    <div className="space-y-8">
      <div className="break-inside-avoid rounded-xl border border-slate-200 bg-slate-50 p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm font-semibold text-slate-900">재작성본 서류 자동 필터 재심사</p>
          <div className="flex items-center gap-2">
            <VerdictBadge verdict={report.summary.atsBefore} size="md" />
            <span aria-hidden className="text-slate-400">→</span>
            {after ? <VerdictBadge verdict={after} size="md" /> : <span className="text-sm text-slate-400">재심사 없음</span>}
          </div>
        </div>
        {rescreen && (
          <>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">{rescreen.oneLiner}</p>
            {rescreen.keywordsMissing.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-slate-500">여전히 빠진 키워드</span>
                {rescreen.keywordsMissing.map((k, i) => (
                  <Chip key={i} tone="negative">
                    {k}
                  </Chip>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <SubHeading>개선된 이력서</SubHeading>
          <p className="text-xs text-slate-500">
            <mark className="rounded bg-amber-100 px-1 text-amber-900">[ADD: …]</mark> 표시는 직접 채워야 하는 사실입니다.
          </p>
        </div>
        <article className="rounded-xl border border-slate-200 bg-white px-5 py-6 shadow-sm sm:px-10 sm:py-10 print:border-slate-300 print:shadow-none">
          <MiniMarkdown source={rw.resumeMarkdown} />
        </article>
      </div>

      {rw.addQuestions.length > 0 && (
        <div className="break-inside-avoid rounded-xl border border-amber-200 bg-amber-50/60 p-5">
          <h3 className="mb-3 text-sm font-semibold text-amber-900">채워야 할 정보 — 답하면 이력서가 완성됩니다</h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-slate-800 marker:font-semibold marker:text-amber-700">
            {rw.addQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      )}

      {rw.changes.length > 0 && (
        <div>
          <SubHeading>변경 내역 (전 → 후)</SubHeading>
          <ul className="space-y-3">
            {rw.changes.map((c, i) => (
              <li key={i} className="break-inside-avoid overflow-hidden rounded-xl border border-slate-200 bg-white">
                {c.mistakeRank !== null && (
                  <p className="border-b border-slate-100 bg-slate-50 px-4 py-1.5 text-xs font-medium text-slate-500">
                    문제점 #{c.mistakeRank} 수정
                  </p>
                )}
                <div className="grid sm:grid-cols-2">
                  <div className="border-b border-slate-100 px-4 py-3 sm:border-b-0 sm:border-r">
                    <p className="text-[11px] font-semibold text-rose-600">전</p>
                    <p className="mt-1 break-words text-sm leading-relaxed text-slate-500">
                      {c.before ?? <span className="italic text-slate-400">(새로 추가)</span>}
                    </p>
                  </div>
                  <div className="px-4 py-3">
                    <p className="text-[11px] font-semibold text-emerald-600">후</p>
                    <p className="mt-1 break-words text-sm leading-relaxed text-slate-900">{renderInline(c.after, `c${i}`)}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rw.assumptions.length > 0 && (
        <div className="break-inside-avoid">
          <SubHeading>추정한 내용</SubHeading>
          <p className="-mt-1 mb-2 text-xs text-slate-500">원본에 없어 추정으로 처리했습니다. 사실과 다르면 고쳐 주세요.</p>
          <BulletList items={rw.assumptions} />
        </div>
      )}
    </div>
  );
}
