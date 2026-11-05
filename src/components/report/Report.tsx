/**
 * 진단 보고서(웹). 순수 표현 컴포넌트 — 훅·클라이언트 상태 없음, 서버/클라이언트 어디서든 렌더링 가능.
 * 섹션 순서는 ARCHITECTURE §8과 같고 PDF(report/pdf.tsx)와 일치한다.
 */
import type { ReactNode } from "react";
import type { ReportModel } from "@/lib/report/types";
import { Disclaimer } from "./Disclaimer";
import { ImprovementPlanSection } from "./ImprovementPlanSection";
import { JdFitSection } from "./JdFitSection";
import { MistakesList } from "./MistakesList";
import { ReviewerDetails } from "./ReviewerDetails";
import { ReviewerVerdicts } from "./ReviewerVerdicts";
import { RewriteSection } from "./RewriteSection";
import { SummaryHeader } from "./SummaryHeader";
import { Section } from "./primitives";

interface TocItem {
  id: string;
  label: string;
  count?: number;
}

function tocItems(r: ReportModel): TocItem[] {
  return [
    { id: "summary", label: "요약" },
    { id: "reviewers", label: "심사위원 7명의 판정" },
    { id: "jd", label: r.jd?.analysis.source === "inferred" ? "직무 요건 분석(추정)" : "JD 분석·적합도" },
    { id: "mistakes", label: "문제점", count: r.mistakes.length || undefined },
    { id: "plan", label: "개선 방향성" },
    { id: "rewrite", label: "개선된 이력서" },
    { id: "details", label: "심사위원별 상세" },
    { id: "disclaimer", label: "고지" },
  ];
}

function Toc({ items }: { items: TocItem[] }) {
  return (
    <nav aria-label="보고서 목차" className="sticky top-6">
      <p className="mb-3 text-xs font-semibold tracking-widest text-slate-400">목차</p>
      <ol className="space-y-0.5 border-l border-slate-200">
        {items.map((it, i) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              className="-ml-px flex items-center justify-between gap-2 border-l-2 border-transparent py-1.5 pl-3 pr-1 text-sm text-slate-500 transition-colors hover:border-indigo-600 hover:text-slate-900 focus-visible:border-indigo-600 focus-visible:text-slate-900 focus-visible:outline-none"
            >
              <span>
                <span className="mr-1.5 tabular-nums text-slate-300">{i + 1}</span>
                {it.label}
              </span>
              {it.count !== undefined && (
                <span className="rounded-full bg-slate-100 px-1.5 text-[11px] font-semibold tabular-nums text-slate-500">{it.count}</span>
              )}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function MobileToc({ items }: { items: TocItem[] }) {
  return (
    <nav aria-label="보고서 목차" className="-mx-4 mb-8 overflow-x-auto px-4 lg:hidden print:hidden">
      <ol className="flex w-max gap-2">
        {items.map((it) => (
          <li key={it.id}>
            <a
              href={`#${it.id}`}
              className="block whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
            >
              {it.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Report({
  report,
  actions,
  reviewerChat,
}: {
  report: ReportModel;
  actions?: ReactNode;
  /** 주면 심사위원 카드에 '이 심사위원과 대화' 버튼을 단다(본인 진단 화면만. 공유 화면은 주지 않는다). */
  reviewerChat?: { diagnosisId: string };
}) {
  const items = tocItems(report);
  const jdInferred = report.jd?.analysis.source === "inferred";
  return (
    <div className="bg-white text-slate-900 antialiased print:bg-white">
      {/* 목차는 왼쪽 고정 폭, 본문은 남은 폭을 모두 쓴다(긴 문단은 각 섹션에서 폭을 제한). */}
      <div className="w-full px-4 py-8 sm:px-6 sm:py-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-10 lg:px-8 xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-12 print:block print:px-0 print:py-0">
        <aside className="hidden lg:block print:hidden">
          <Toc items={items} />
        </aside>

        <div className="min-w-0">
          <MobileToc items={items} />
          <SummaryHeader report={report} actions={actions} />

          <div className="mt-12 space-y-14 print:mt-8 print:space-y-10">
            <Section id="reviewers" number={2} title="심사위원 7명의 판정" description="서로의 결과를 보지 않고 각자 이 이력서를 떨어뜨릴 이유를 찾았습니다.">
              <ReviewerVerdicts reviewers={report.reviewers} chatDiagnosisId={reviewerChat?.diagnosisId} />
            </Section>

            <Section
              id="jd"
              number={3}
              title={jdInferred ? "직무 요건 분석과 적합도" : "JD 분석과 적합도"}
              description="공고가 실제로 원하는 것과, 이력서가 각 요건을 얼마나 증명하는지 대조했습니다."
            >
              <JdFitSection report={report} />
            </Section>

            <Section id="mistakes" number={4} title="문제점 — 심각도순" description="일곱 명의 지적을 합치고 중복을 묶었습니다. 위에 있을수록 탈락에 직접적입니다.">
              <MistakesList mistakes={report.mistakes} />
            </Section>

            <Section id="plan" number={5} title="개선 방향성" description="문장 수정을 넘어, 이 직무에 맞춰 무엇을 먼저 바꾸고 어떤 역량을 채울지 정리했습니다.">
              <ImprovementPlanSection report={report} />
            </Section>

            <Section id="rewrite" number={6} title="개선된 이력서" description="원본과 같은 사실만으로 다시 썼습니다. 모르는 사실은 지어내지 않고 [ADD]로 남겼습니다.">
              <RewriteSection report={report} />
            </Section>

            <Section id="details" number={7} title="심사위원별 상세">
              <ReviewerDetails reviewers={report.reviewers} chatDiagnosisId={reviewerChat?.diagnosisId} />
            </Section>

            <Section id="disclaimer" number={8} title="고지">
              <Disclaimer report={report} />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Report;
