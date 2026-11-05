/**
 * 지원 성과 카드(서버·클라이언트 공용, 상태 없음). 실제로 일어난 결과만 보여 준다 — 진단 적합도 점수는 결과 옆에 참고로
 * 나란히 둘 뿐 예측처럼 표현하지 않는다.
 */
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { APPLICATION_STAGE_LABELS, type InsightsResponse, type Suggestion } from "@/lib/domain/applications";
import { percent, STAGE_DOT, STAGE_TONE } from "./stage-style";

const SUGGESTION_KIND: Record<Suggestion["kind"], { label: string; tone: BadgeTone }> = {
  deadline: { label: "마감", tone: "warning" },
  next_step: { label: "일정", tone: "info" },
  follow_up: { label: "팔로업", tone: "accent" },
  resume: { label: "이력서", tone: "neutral" },
  pipeline: { label: "점검", tone: "neutral" },
};

export function SuggestionList({ items, limit }: { items: Suggestion[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  if (shown.length === 0) return <p className="text-sm text-slate-500">지금 급한 일은 없습니다. 새 공고를 보관하거나 이력서를 다듬어 두기 좋은 때입니다.</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {shown.map((s, i) => {
        const body = (
          <span className="flex items-start gap-2.5 py-2.5 text-sm leading-relaxed text-slate-700">
            <Badge tone={SUGGESTION_KIND[s.kind].tone} className="mt-0.5 shrink-0">
              {SUGGESTION_KIND[s.kind].label}
            </Badge>
            <span className="min-w-0">{s.message}</span>
          </span>
        );
        return (
          <li key={`${s.kind}-${s.postingId ?? s.applicationId ?? i}`}>
            {s.href ? (
              <Link href={s.href} className="block rounded-md hover:bg-slate-50">
                {body}
              </Link>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2.5">
      <p className="truncate text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** 내 진단 화면 위의 요약 카드: 응답률·진행 중·할 일 몇 개. 지원 기록도 할 일도 없으면 그리지 않는다. */
export function InsightsSummaryCard({ insights }: { insights: InsightsResponse }) {
  const total = insights.funnel.reduce((n, r) => n + r.current, 0);
  if (total === 0 && insights.suggestions.length === 0) return null;
  const active = insights.funnel.filter((r) => ["applied", "assignment", "interview"].includes(r.stage)).reduce((n, r) => n + r.current, 0);
  const rr = insights.responseRate;
  return (
    <Card>
      <CardHeader
        title="지원 현황"
        description="지금까지 낸 지원의 실제 결과와 오늘 할 일"
        action={
          <Link href="/app/applications" className={buttonClass("secondary", "sm")}>
            지원 현황 보기
          </Link>
        }
      />
      <CardBody className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="grid grid-cols-3 gap-2 self-start">
          <Stat label="응답률" value={percent(rr.rate)} hint={`${rr.responded}/${rr.submitted}건`} />
          <Stat label="진행 중" value={String(active)} />
          <Stat label="전체" value={String(total)} />
        </div>
        <SuggestionList items={insights.suggestions} limit={4} />
      </CardBody>
    </Card>
  );
}

/** 지원 현황 화면의 성과 묶음: 단계 도달, 이력서 버전별, 회사별, 할 일. */
export function InsightsDetail({ insights }: { insights: InsightsResponse }) {
  const rr = insights.responseRate;
  const maxReached = Math.max(1, ...insights.funnel.map((r) => r.reached));
  return (
    <div className="grid gap-4 xl:grid-cols-2 min-[1920px]:grid-cols-4">
      <Card>
        <CardHeader title="할 일" description="마감·일정·팔로업 기준으로 고른 제안" />
        <CardBody className="pt-2">
          <SuggestionList items={insights.suggestions} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="단계 도달"
          description={
            <>
              응답률 <strong className="text-slate-800">{percent(rr.rate)}</strong> ({rr.responded}/{rr.submitted}건) — 지원서를 낸 지원 중 과제·면접·최종
              합격까지 한 번이라도 간 비율
            </>
          }
        />
        <CardBody>
          <ul className="space-y-2">
            {insights.funnel.map((r) => (
              <li key={r.stage} className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm">
                <span className="flex items-center gap-1.5 text-slate-700">
                  <span aria-hidden className={cn("size-2 rounded-full", STAGE_DOT[r.stage])} />
                  {APPLICATION_STAGE_LABELS[r.stage]}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                  <span className={cn("block h-full rounded-full", STAGE_DOT[r.stage])} style={{ width: `${(r.reached / maxReached) * 100}%` }} />
                </span>
                <span className="text-right text-xs whitespace-nowrap tabular-nums text-slate-500">
                  도달 {r.reached} · 지금 {r.current}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="이력서 버전별 결과" description="지원서를 낸 지원만 셉니다. 원본 이력서를 지워도 남습니다." />
        <CardBody className="pt-3">
          {insights.resumePerformance.length === 0 ? (
            <p className="text-sm text-slate-500">아직 지원서를 낸 기록이 없습니다.</p>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 font-medium">이력서</th>
                  <th className="w-14 pb-2 text-right font-medium">지원</th>
                  <th className="w-14 pb-2 text-right font-medium">응답</th>
                  <th className="w-14 pb-2 text-right font-medium">응답률</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {insights.resumePerformance.map((r) => (
                  <tr key={r.resumeVersionId ?? r.resumeId ?? "none"}>
                    <td className={cn("truncate py-2", r.resumeId || r.resumeVersionId ? "text-slate-800" : "text-slate-500")} title={r.label}>
                      {r.label}
                    </td>
                    <td className="py-2 text-right tabular-nums">{r.submitted}</td>
                    <td className="py-2 text-right tabular-nums">{r.responded}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{percent(r.rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="회사별" description="진단 적합도는 진단 당시 서류 평가 점수로, 결과 옆에 참고로만 둡니다." />
        <CardBody className="pt-3">
          {insights.companies.length === 0 ? (
            <p className="text-sm text-slate-500">아직 지원 기록이 없습니다.</p>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 font-medium">회사</th>
                  <th className="w-10 pb-2 text-right font-medium">지원</th>
                  <th className="w-24 pb-2 text-right font-medium">결과</th>
                  <th className="w-16 pb-2 text-right font-medium">적합도</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {insights.companies.slice(0, 12).map((c) => (
                  <tr key={c.company}>
                    <td className="truncate py-2 text-slate-800" title={c.company}>
                      {c.company}
                    </td>
                    <td className="py-2 text-right tabular-nums">{c.applications}</td>
                    <td className="py-2 text-right">
                      <Badge tone={STAGE_TONE[c.bestStage]}>{APPLICATION_STAGE_LABELS[c.bestStage]}</Badge>
                    </td>
                    <td className="py-2 text-right tabular-nums text-slate-600">{c.matchScore ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
