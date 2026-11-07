"use client";
/**
 * 포트폴리오 양식 고르기(경험 그래프 포트폴리오 만들기·다시 만들기). 양식마다 이름·대상·설명·분량과 프로젝트 구역 순서를 카드로 보여 주고,
 * 그래프에 맞는 추천 양식(GET /api/portfolios/graph의 recommendedTemplate)에 '추천' 배지를 단다.
 */
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import {
  PORTFOLIO_TEMPLATES,
  type PortfolioTemplate,
  type PortfolioTemplateId,
  type PortfolioTemplateRecommendation,
} from "@/lib/domain/portfolio-templates";

/** 카드에 보일 구역 순서(프로젝트 구역, 링크 제외). */
export function templateSectionPreview(tpl: PortfolioTemplate): string[] {
  return tpl.project.filter((s) => s.kind !== "links").map((s) => s.heading);
}

export function PortfolioTemplatePicker({
  value,
  onChange,
  recommended,
  disabled = false,
}: {
  value: PortfolioTemplateId;
  onChange: (id: PortfolioTemplateId) => void;
  recommended: PortfolioTemplateRecommendation | null;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium text-slate-800">
        양식{" "}
        <span className="font-normal text-slate-500">
          (구역 순서·제목이 양식을 따릅니다{recommended ? ` · 추천: ${recommended.reason}` : ""})
        </span>
      </legend>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PORTFOLIO_TEMPLATES.map((tpl) => {
          const on = value === tpl.id;
          return (
            <label
              key={tpl.id}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-sm",
                on ? "border-indigo-500 bg-indigo-50/60" : "border-slate-200 hover:border-slate-300",
              )}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="graph-portfolio-template"
                  value={tpl.id}
                  checked={on}
                  onChange={() => onChange(tpl.id)}
                  className="accent-indigo-600"
                />
                <span className="font-medium text-slate-900">{tpl.name}</span>
                {recommended?.id === tpl.id && <Badge tone="positive">추천</Badge>}
              </span>
              <span className="text-xs text-slate-600">대상: {tpl.audience}</span>
              <span className="line-clamp-2 text-xs text-slate-500">{tpl.description}</span>
              <span className="mt-0.5 text-xs text-slate-500">
                <span className="text-slate-400">구역 </span>
                {templateSectionPreview(tpl).join(" → ")}
              </span>
              <span className="text-xs text-slate-400">{tpl.length}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
