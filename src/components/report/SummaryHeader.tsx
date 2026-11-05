import type { ReactNode } from "react";
import { formatReportDate } from "@/lib/report/model";
import type { ReportModel, VerdictView } from "@/lib/report/types";
import { BulletList, VerdictBadge, cx } from "./primitives";

function Ring({ value, max, label, sub, color }: { value: number; max: number; label: string; sub: string; color: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 80 80" className="h-20 w-20 shrink-0 -rotate-90" aria-hidden>
        <circle cx="40" cy="40" r={r} fill="none" strokeWidth="8" className="stroke-slate-100" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          className={color}
        />
      </svg>
      <div>
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight text-slate-900">{sub}</p>
      </div>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 75) return "stroke-emerald-500";
  if (score >= 50) return "stroke-amber-500";
  return "stroke-rose-500";
}

function AtsFlow({ before, after }: { before: VerdictView; after: VerdictView | null }) {
  return (
    <div className="flex h-full flex-col justify-center">
      <p className="text-xs font-medium text-slate-500">서류 자동 필터 (전 → 후)</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={before} size="md" />
        <span aria-label="에서" className="text-slate-400">
          →
        </span>
        {after ? <VerdictBadge verdict={after} size="md" /> : <span className="text-sm text-slate-400">재심사 없음</span>}
      </div>
      <p className="mt-2 text-xs text-slate-500">원본 이력서 → 재작성 이력서</p>
    </div>
  );
}

function StatBox({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-xl border border-slate-200 bg-white p-4 break-inside-avoid", className)}>{children}</div>;
}

export function SummaryHeader({ report, actions }: { report: ReportModel; actions?: ReactNode }) {
  const { meta, summary } = report;
  const passRatio = summary.totalReviewers ? summary.positiveCount / summary.totalReviewers : 0;
  return (
    <header id="summary" className="scroll-mt-24">
      {/* 버튼이 많아도 제목 폭을 빼앗지 않도록 제목과 액션을 위아래로 둔다. */}
      <div className="flex flex-col gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-widest text-indigo-600">커리어루프 보고서</p>
          <h1 className="mt-2 break-words text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{meta.title}</h1>
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-500">
            <div className="flex gap-1.5">
              <dt className="text-slate-400">지원 직무</dt>
              <dd className="font-medium text-slate-700">{meta.targetRole}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-slate-400">상황</dt>
              <dd className="font-medium text-slate-700">{meta.situationLabel}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-slate-400">진단일</dt>
              <dd className="font-medium text-slate-700">{formatReportDate(meta.createdAt)}</dd>
            </div>
            {!meta.hasJd && (
              <div>
                <dd className="font-medium text-amber-700">공고 없이 진단</dd>
              </div>
            )}
            {meta.hasPortfolio && (
              <div className="flex min-w-0 gap-1.5">
                <dt className="sr-only">추가 자료</dt>
                <dd className="truncate font-medium text-indigo-700" title={meta.portfolioFileName ?? undefined}>
                  포트폴리오 포함{meta.portfolioFileName ? ` · ${meta.portfolioFileName}` : ""}
                </dd>
              </div>
            )}
          </dl>
        </div>
        {actions && <div className="border-t border-slate-100 pt-4 print:hidden">{actions}</div>}
      </div>

      <p className="mt-8 border-l-4 border-indigo-600 pl-4 text-lg font-semibold leading-relaxed text-slate-900 sm:text-xl">
        {summary.headline}
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        <StatBox>
          <Ring
            value={summary.positiveCount}
            max={summary.totalReviewers}
            label="심사위원 통과"
            sub={`${summary.positiveCount}/${summary.totalReviewers} 통과`}
            color={passRatio >= 0.7 ? "stroke-emerald-500" : passRatio >= 0.4 ? "stroke-amber-500" : "stroke-rose-500"}
          />
        </StatBox>
        <StatBox>
          {summary.matchScore !== null ? (
            <Ring
              value={summary.matchScore}
              max={100}
              label={meta.hasJd ? "JD 적합도" : "직무 적합도(추정)"}
              sub={`${summary.matchScore}점`}
              color={scoreColor(summary.matchScore)}
            />
          ) : (
            <div className="flex h-full flex-col justify-center">
              <p className="text-xs font-medium text-slate-500">JD 적합도</p>
              <p className="mt-1 text-sm text-slate-400">아직 계산되지 않았습니다</p>
            </div>
          )}
        </StatBox>
        <StatBox>
          <AtsFlow before={summary.atsBefore} after={summary.atsAfter} />
        </StatBox>
      </div>

      {(summary.strengths.length > 0 || summary.closestToReject) && (
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {summary.strengths.length > 0 && (
            <div className="break-inside-avoid rounded-xl bg-emerald-50/60 p-5 ring-1 ring-inset ring-emerald-600/10">
              <h3 className="mb-2 text-sm font-semibold text-emerald-900">실제로 먹히는 강점</h3>
              <BulletList items={summary.strengths} />
            </div>
          )}
          {summary.closestToReject && (
            <div className="break-inside-avoid rounded-xl bg-slate-50 p-5 ring-1 ring-inset ring-slate-200">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">
                가장 거절에 가까웠던 심사위원 · {summary.closestToReject.reviewerName}
              </h3>
              <p className="text-sm leading-relaxed text-slate-700">{summary.closestToReject.why}</p>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
