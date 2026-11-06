/** 관리자 '사용량' 화면의 공용 표·기간 선택(서버 컴포넌트). */
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { formatMicroUsd, formatTokens, USAGE_PERIOD_LABELS, USAGE_PERIODS, type UsagePeriod, type UsageTotals } from "@/lib/domain/llm-usage";

export function PeriodTabs({ period, hrefFor }: { period: UsagePeriod; hrefFor: (p: UsagePeriod) => string }) {
  return (
    <nav aria-label="기간" className="flex gap-1 rounded-lg bg-slate-100 p-1">
      {USAGE_PERIODS.map((p) => (
        <Link
          key={p}
          href={hrefFor(p)}
          aria-current={p === period ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
            p === period ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
          )}
        >
          {USAGE_PERIOD_LABELS[p]}
        </Link>
      ))}
    </nav>
  );
}

/** 합계 요약 카드 줄. */
export function UsageSummary({ totals }: { totals: UsageTotals }) {
  const items: { label: string; value: string; hint?: string }[] = [
    {
      label: "추정 비용",
      value: formatMicroUsd(totals.costMicroUsd),
      hint: totals.unpricedCalls > 0 ? `비용 미산정 ${formatTokens(totals.unpricedCalls)}건 제외` : undefined,
    },
    { label: "호출", value: formatTokens(totals.calls), hint: totals.failedCalls > 0 ? `실패 ${formatTokens(totals.failedCalls)}건` : undefined },
    { label: "입력 토큰", value: formatTokens(totals.inputTokens) },
    { label: "출력 토큰", value: formatTokens(totals.outputTokens) },
    { label: "캐시 읽기 · 쓰기", value: `${formatTokens(totals.cacheReadTokens)} · ${formatTokens(totals.cacheWriteTokens)}` },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map((it) => (
        <Card key={it.label} className="px-4 py-3">
          <dt className="text-xs font-medium text-slate-500">{it.label}</dt>
          <dd className="mt-1 text-lg font-semibold text-slate-900 tabular-nums">{it.value}</dd>
          {it.hint && <dd className="mt-0.5 text-xs text-slate-400">{it.hint}</dd>}
        </Card>
      ))}
    </dl>
  );
}

export const TH = "px-4 py-2.5";
export const TH_NUM = "px-4 py-2.5 text-right";
export const TD_NUM = "px-4 py-3 text-right whitespace-nowrap tabular-nums text-slate-700";

/** 호출·토큰·비용 숫자 칸(머리글은 UsageNumberHeads). */
export function UsageNumberCells({ t }: { t: UsageTotals }) {
  return (
    <>
      <td className={TD_NUM}>
        {formatTokens(t.calls)}
        {t.failedCalls > 0 && <span className="ml-1 text-xs text-rose-600">(실패 {formatTokens(t.failedCalls)})</span>}
      </td>
      <td className={TD_NUM}>{formatTokens(t.inputTokens)}</td>
      <td className={TD_NUM}>{formatTokens(t.outputTokens)}</td>
      <td className={TD_NUM}>
        {formatTokens(t.cacheReadTokens)} · {formatTokens(t.cacheWriteTokens)}
      </td>
      <td className={cn(TD_NUM, "font-medium text-slate-900")}>
        {t.calls > 0 && t.unpricedCalls === t.calls ? (
          <span className="text-slate-400">—</span>
        ) : (
          <>
            {formatMicroUsd(t.costMicroUsd)}
            {t.unpricedCalls > 0 && (
              <span className="ml-1 text-xs font-normal text-slate-400" title="CLI 엔진·단가를 모르는 모델 호출은 비용에서 뺐습니다">
                (+미산정 {formatTokens(t.unpricedCalls)}건)
              </span>
            )}
          </>
        )}
      </td>
    </>
  );
}

export function UsageNumberHeads() {
  return (
    <>
      <th scope="col" className={TH_NUM}>
        호출
      </th>
      <th scope="col" className={TH_NUM}>
        입력
      </th>
      <th scope="col" className={TH_NUM}>
        출력
      </th>
      <th scope="col" className={TH_NUM}>
        캐시 읽기 · 쓰기
      </th>
      <th scope="col" className={TH_NUM}>
        추정 비용
      </th>
    </>
  );
}

/** 키(작업·날짜·모델)별 표. */
export function KeyedUsageTable({
  title,
  keyHead,
  rows,
  label,
  empty,
}: {
  title: string;
  keyHead: string;
  rows: (UsageTotals & { key: string })[];
  label?: (key: string) => ReactNode;
  empty?: string;
}) {
  return (
    <Card className="overflow-hidden">
      <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">{empty ?? "이 기간에 기록된 사용량이 없습니다."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-500">
              <tr>
                <th scope="col" className={TH}>
                  {keyHead}
                </th>
                <UsageNumberHeads />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="px-4 py-3 text-slate-900">{label ? label(r.key) : r.key}</td>
                  <UsageNumberCells t={r} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
