import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { KeyedUsageTable, PeriodTabs, UsageSummary } from "@/components/admin/UsageTables";
import { requireAdmin } from "@/lib/auth/session";
import { isUsagePeriod, llmUsageTaskLabel, periodStart, type UsagePeriod } from "@/lib/domain/llm-usage";
import { getUserUsage } from "@/lib/llm/usage-report";

type Props = {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "회원 사용량" };
export const dynamic = "force-dynamic";

/** 한 회원의 토큰 사용량(관리자만 — 아니면 404): 합계·작업별(심사 단계까지)·날짜별·모델별. */
export default async function AdminUserUsagePage({ params, searchParams }: Props) {
  const { userId } = await params;
  await requireAdmin(`/app/admin/usage/${encodeURIComponent(userId)}`);
  const sp = await searchParams;
  const p = Array.isArray(sp.period) ? sp.period[0] : sp.period;
  const period: UsagePeriod = isUsagePeriod(p) ? p : "30d";
  const usage = await getUserUsage(userId, { since: periodStart(period) });
  if (!usage) notFound();
  const base = `/app/admin/usage/${encodeURIComponent(userId)}`;
  const hrefFor = (x: UsagePeriod) => (x === "30d" ? base : `${base}?period=${x}`);

  return (
    <div className="space-y-6">
      <Link
        href={period === "30d" ? "/app/admin/usage" : `/app/admin/usage?period=${period}`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
      >
        <span aria-hidden>←</span> 사용량
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight break-all text-slate-900">{usage.user.email}</h1>
          <p className="mt-1 text-sm text-slate-500">{usage.user.name ?? "이름 없음"} · 추정 비용은 Claude API 정가 기준입니다(청구 금액 아님).</p>
        </div>
        <PeriodTabs period={period} hrefFor={hrefFor} />
      </div>

      <UsageSummary totals={usage.totals} />
      <KeyedUsageTable title="작업별 사용량" keyHead="작업" rows={usage.byTask} label={llmUsageTaskLabel} />
      <KeyedUsageTable title="날짜별 사용량" keyHead="날짜(한국 시간)" rows={usage.byDay} />
      <KeyedUsageTable title="엔진 · 모델별 사용량" keyHead="엔진 · 모델" rows={usage.byModel} />
    </div>
  );
}
