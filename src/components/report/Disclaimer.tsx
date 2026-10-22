import { CREDIT_LINE, DISCLAIMER_TEXT, formatReportDate } from "@/lib/report/model";
import type { ReportModel } from "@/lib/report/types";

export function Disclaimer({ report }: { report: ReportModel }) {
  const m = report.meta;
  return (
    <div className="break-inside-avoid rounded-xl bg-slate-50 p-5 text-sm leading-relaxed text-slate-600 ring-1 ring-inset ring-slate-200">
      <p>{DISCLAIMER_TEXT}</p>
      <p className="mt-3 text-xs text-slate-500">
        모든 인용은 이력서 원문과 자동 대조했으며, 찾지 못한 인용에는 ‘원문에서 찾지 못함’을 표시했습니다. 심사위원 7명은 서로의 결과를 보지
        않고 독립적으로 판정했습니다.
      </p>
      <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-200 pt-3 text-xs text-slate-500">
        <div className="flex gap-1.5">
          <dt>모델</dt>
          <dd className="font-mono text-slate-600">{m.model}</dd>
        </div>
        {m.completedAt && (
          <div className="flex gap-1.5">
            <dt>완료</dt>
            <dd className="text-slate-600">{formatReportDate(m.completedAt)}</dd>
          </div>
        )}
        {m.resumeFileName && (
          <div className="flex gap-1.5">
            <dt>이력서 파일</dt>
            <dd className="text-slate-600">{m.resumeFileName}</dd>
          </div>
        )}
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        {CREDIT_LINE.replace("원본: ", "원본 스킬: ")} —{" "}
        <a
          href="https://github.com/alexyc9381/hiring-panel-skill"
          rel="noopener noreferrer"
          target="_blank"
          className="text-indigo-700 underline underline-offset-2"
        >
          github.com/alexyc9381/hiring-panel-skill
        </a>
      </p>
    </div>
  );
}
