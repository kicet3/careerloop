import type { Metadata } from "next";
import Link from "next/link";
import { KeyedUsageTable, PeriodTabs, TH, UsageNumberCells, UsageNumberHeads, UsageSummary } from "@/components/admin/UsageTables";
import { formatDateTime } from "@/components/app/stages";
import { Card } from "@/components/ui/Card";
import { requireAdmin } from "@/lib/auth/session";
import { isUsagePeriod, llmUsageTaskLabel, periodStart, type UsagePeriod } from "@/lib/domain/llm-usage";
import { CHAT_SCOPE_GUARD } from "@/lib/chat/scope-guard-store";
import { listScopeGuardByUser, listUsageByTask, listUsageByUser } from "@/lib/llm/usage-report";

export const metadata: Metadata = { title: "사용량" };
export const dynamic = "force-dynamic";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const hrefFor = (p: UsagePeriod) => (p === "30d" ? "/app/admin/usage" : `/app/admin/usage?period=${p}`);

/** 토큰 사용량(관리자만 — 아니면 404): 기간별 사용자 순위(추정 비용 순)·합계·작업별 사용량. */
export default async function AdminUsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin("/app/admin/usage");
  const params = await searchParams;
  const p = first(params.period);
  const period: UsagePeriod = isUsagePeriod(p) ? p : "30d";
  const since = periodStart(period);
  const [{ users, totals }, byTask, guard] = await Promise.all([
    listUsageByUser({ since }),
    listUsageByTask({ since }),
    listScopeGuardByUser({ since, window: CHAT_SCOPE_GUARD }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">사용량</h1>
          <p className="mt-1 text-sm text-slate-500">
            AI 호출마다 쓴 토큰과 추정 비용(Claude API 정가 기준, 청구 금액 아님)입니다. 계정 로그인(CLI) 엔진 호출은 토큰만 세고 비용은 매기지 않습니다.
            &lsquo;오늘&rsquo;·&lsquo;N일&rsquo;은 한국 시간 자정 기준입니다.
          </p>
        </div>
        <PeriodTabs period={period} hrefFor={hrefFor} />
      </div>

      <UsageSummary totals={totals} />

      <Card className="overflow-hidden">
        <h2 className="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-900">회원별 사용량</h2>
        {users.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">이 기간에 기록된 사용량이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <tr>
                  <th scope="col" className={TH}>
                    회원
                  </th>
                  <UsageNumberHeads />
                  <th scope="col" className={TH}>
                    최근 사용
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.userId ?? "-"} className="align-top">
                    <td className="px-4 py-3">
                      {u.userId ? (
                        <Link
                          href={`/app/admin/usage/${encodeURIComponent(u.userId)}${period === "30d" ? "" : `?period=${period}`}`}
                          className="font-medium break-all text-indigo-700 hover:underline"
                        >
                          {u.email ?? u.userId}
                        </Link>
                      ) : (
                        <span className="font-medium text-slate-500">회원 없음(시스템)</span>
                      )}
                      {u.userId && <p className="mt-0.5 text-xs text-slate-500">{u.name ?? "이름 없음"}</p>}
                    </td>
                    <UsageNumberCells t={u} />
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-600">{u.lastUsedAt ? formatDateTime(u.lastUsedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
                <tr>
                  <td className="px-4 py-3 text-slate-900">합계 ({users.filter((u) => u.userId).length}명)</td>
                  <UsageNumberCells t={totals} />
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      <KeyedUsageTable title="작업별 사용량" keyHead="작업" rows={byTask} label={llmUsageTaskLabel} />

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">경험 대화 가드레일</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            경험 정리하기·경험 질문하기에서 경험 그래프와 관련 없는 요청(범위 밖)·남용(시스템 프롬프트 요구 등)으로 판정해 안내로 바꾼 횟수입니다.
            1시간에 {CHAT_SCOPE_GUARD.limit}번이면 그 회원의 경험 대화를 잠시 막습니다. 요청 본문은 저장하지 않습니다.
          </p>
        </div>
        {guard.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">이 기간에 기록된 판정이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <tr>
                  <th scope="col" className={TH}>
                    회원
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    합계
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    범위 밖
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    남용
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    사전 검사
                  </th>
                  <th scope="col" className={TH}>
                    최근 1시간
                  </th>
                  <th scope="col" className={TH}>
                    최근 판정
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {guard.map((g) => (
                  <tr key={g.userId}>
                    <td className="px-4 py-3">
                      <p className="font-medium break-all text-slate-900">{g.email ?? g.userId}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{g.name ?? "이름 없음"}</p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.total.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.offTopic.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.abuse.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{g.prefilter.toLocaleString()}</td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {g.recentWindow >= CHAT_SCOPE_GUARD.limit ? (
                        <span className="font-semibold text-red-700">차단 중 ({g.recentWindow})</span>
                      ) : (
                        <span className="text-slate-600">{g.recentWindow}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-600">{g.lastAt ? formatDateTime(g.lastAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
