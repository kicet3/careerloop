import type { Metadata } from "next";
import { ApplicationsBoard } from "@/components/applications/ApplicationsBoard";
import type { PanelTarget } from "@/components/applications/ApplicationPanel";
import { InsightsDetail } from "@/components/applications/InsightsPanels";
import { Alert } from "@/components/ui/Alert";
import { getInsights } from "@/lib/applications/insights-service";
import { listApplicationFormOptions } from "@/lib/applications/options";
import { listApplications } from "@/lib/applications/service";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "지원 현황" };
export const dynamic = "force-dynamic";

type Search = Promise<{ [key: string]: string | string[] | undefined }>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null;

/** 지원 현황: 단계별 보드 + 실제 결과 집계. ?new=1&postingId=<id>(공고 상세에서 '지원 기록 추가'), ?open=<지원 id>(제안에서). */
export default async function ApplicationsPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("/app/applications");
  const sp = await searchParams;
  const [items, options, insights] = await Promise.all([
    listApplications(user.id),
    listApplicationFormOptions(user.id),
    // 집계가 실패해도 지원 보드는 보여 준다(/app과 같은 처리).
    getInsights(user.id).catch((err) => {
      console.error("[app/applications] 지원 인사이트 집계 실패", err);
      return null;
    }),
  ]);

  const openId = one(sp.open);
  const target: PanelTarget | null =
    one(sp.new) === "1"
      ? { mode: "new", postingId: one(sp.postingId) }
      : openId && items.some((a) => a.id === openId)
        ? { mode: "edit", id: openId }
        : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">지원 현황</h1>
        <p className="mt-1 text-sm text-slate-500">
          지원한 회사의 진행 단계와 다음 일정, 낸 이력서 버전을 한눈에 봅니다. {items.length}건
        </p>
      </div>
      {/* 같은 화면 안에서 ?open=·?new= 링크를 눌러도 패널이 열리도록 쿼리가 바뀌면 보드를 새로 그린다. */}
      <ApplicationsBoard key={`${one(sp.new) ?? ""}|${one(sp.postingId) ?? ""}|${openId ?? ""}`} initialItems={items} options={options} initialTarget={target} />
      {items.length > 0 && (
        <section aria-labelledby="insights-heading" className="space-y-3">
          <h2 id="insights-heading" className="text-lg font-semibold text-slate-900">
            결과 모아 보기
          </h2>
          {insights ? (
            <InsightsDetail insights={insights} />
          ) : (
            <Alert tone="warning">결과 집계를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.</Alert>
          )}
        </section>
      )}
    </div>
  );
}
