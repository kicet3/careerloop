import type { FitItem } from "@/lib/domain/schemas";
import { CATEGORY_LABELS, FIT_STATUS_LABELS, PRIORITY_LABELS, keywordStatus } from "@/lib/report/model";
import type { FitRow, ReportModel } from "@/lib/report/types";
import { BulletList, Card, Chip, EmptyState, Pill, QuoteBlock, SubHeading, UnverifiedMark, cx } from "./primitives";

const STATUS_TONE: Record<FitItem["status"], "positive" | "neutral" | "negative"> = {
  met: "positive",
  partial: "neutral",
  missing: "negative",
};

const STATUS_ICON: Record<FitItem["status"], string> = { met: "●", partial: "◐", missing: "○" };

function StatusPill({ row }: { row: FitRow }) {
  if (!row.item) return <Pill tone="muted">미평가</Pill>;
  return (
    <Pill tone={STATUS_TONE[row.item.status]}>
      <span aria-hidden>{STATUS_ICON[row.item.status]}</span>
      {FIT_STATUS_LABELS[row.item.status]}
    </Pill>
  );
}

function keywordTone(keyword: string, present: string[], missing: string[]): "default" | "positive" | "negative" {
  const st = keywordStatus(keyword, present, missing);
  return st === "present" ? "positive" : st === "missing" ? "negative" : "default";
}

/** 요건 본문 + 구분 + 공고 원문 인용(있으면). 표와 모바일 카드가 함께 쓴다. */
function RequirementCell({ row }: { row: FitRow }) {
  return (
    <>
      <p className="font-medium text-slate-900">{row.requirement.text}</p>
      <p className="mt-1 text-xs text-slate-500">
        <span className={row.priority === "must" ? "font-semibold text-indigo-700" : ""}>{PRIORITY_LABELS[row.priority]}</span>
        {" · "}
        {CATEGORY_LABELS[row.requirement.category] ?? row.requirement.category}
      </p>
      {row.jdQuote && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          <span className="font-semibold text-slate-400">공고 </span>“{row.jdQuote.text}”
          {!row.jdQuote.verified && <UnverifiedMark source="jd" />}
        </p>
      )}
    </>
  );
}

function EvidenceCell({ row }: { row: FitRow }) {
  return (
    <>
      {row.evidence && <QuoteBlock quote={row.evidence} className="mb-2 text-xs" />}
      <p className="text-sm leading-relaxed text-slate-600">{row.item?.note ?? "-"}</p>
    </>
  );
}

function CountBar({ counts }: { counts: { met: number; partial: number; missing: number } }) {
  const total = counts.met + counts.partial + counts.missing;
  if (!total) return null;
  const seg = [
    { key: "met", n: counts.met, cls: "bg-emerald-500", label: "충족" },
    { key: "partial", n: counts.partial, cls: "bg-amber-400", label: "부분" },
    { key: "missing", n: counts.missing, cls: "bg-rose-400", label: "미충족" },
  ];
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
        {seg.map((s) => (s.n ? <div key={s.key} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} /> : null))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {seg.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cx("h-2 w-2 rounded-full", s.cls)} />
            {s.label} <strong className="tabular-nums text-slate-900">{s.n}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

export function JdFitSection({ report }: { report: ReportModel }) {
  const jd = report.jd;
  if (!jd) return <EmptyState>JD 분석이 아직 완료되지 않았습니다.</EmptyState>;
  const a = jd.analysis;
  const ats = report.reviewers.find((r) => r.id === "ats");
  const present = ats?.detail.kind === "ats" ? ats.detail.result.keywordsPresent : [];
  const missing = ats?.detail.kind === "ats" ? ats.detail.result.keywordsMissing : [];

  return (
    <div className="space-y-6">
      {a.source === "inferred" && (
        <div role="note" className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span aria-hidden className="font-bold">!</span>
          <p>
            <strong className="font-semibold">공고 없이 직무명으로 추정한 요건입니다.</strong> 실제 공고와 다를 수 있으니 지원할 공고를
            넣어 다시 진단하면 훨씬 정확해집니다.
          </p>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-base font-semibold text-slate-900">{a.roleTitle}</h3>
          {a.company && <span className="text-sm text-slate-500">{a.company}</span>}
          <Pill tone="accent">{a.seniority}</Pill>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-slate-700">{a.summary}</p>
        {a.responsibilities.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-xs font-semibold text-slate-500">주요 업무</p>
            <BulletList items={a.responsibilities} />
          </div>
        )}
      </Card>

      {a.keywords.length > 0 && (
        <div className="break-inside-avoid">
          <SubHeading>핵심 키워드</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {a.keywords.map((k, i) => (
              <Chip key={i} tone={keywordTone(k, present, missing)}>
                {k}
              </Chip>
            ))}
          </div>
          {(present.length > 0 || missing.length > 0) && (
            <p className="mt-2 text-xs text-slate-500">
              <span className="text-emerald-700">초록</span>은 이력서에서 찾은 키워드,{" "}
              <span className="text-rose-700">빨강</span>은 서류 자동 필터가 찾지 못한 키워드입니다.
            </p>
          )}
        </div>
      )}

      {a.hiddenSignals.length > 0 && (
        <div className="break-inside-avoid rounded-xl bg-slate-50 p-5 ring-1 ring-inset ring-slate-200">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">공고의 숨은 신호</h3>
          <BulletList items={a.hiddenSignals} />
        </div>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <SubHeading>적합도 매트릭스</SubHeading>
          {report.summary.matchScore !== null && (
            <p className="text-sm text-slate-500">
              적합도 <strong className="text-lg tabular-nums text-slate-900">{report.summary.matchScore}</strong>/100
            </p>
          )}
        </div>
        <CountBar counts={jd.counts} />
        {jd.fitSummary && <p className="mt-3 text-sm leading-relaxed text-slate-700">{jd.fitSummary}</p>}

        {/* 좁은 화면: 요건마다 카드로 쌓아 근거·메모가 화면 밖으로 밀리지 않게 한다. */}
        <ul className="mt-4 space-y-3 sm:hidden">
          {jd.rows.map((row) => (
            <li
              key={`${row.priority}-${row.requirement.id}`}
              className="break-inside-avoid rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="font-mono text-xs text-slate-500">{row.requirement.id}</span>
                <StatusPill row={row} />
              </div>
              <div className="mt-2">
                <RequirementCell row={row} />
              </div>
              <div className="mt-3 border-t border-slate-100 pt-3">
                <EvidenceCell row={row} />
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 hidden overflow-x-auto rounded-xl border border-slate-200 bg-white sm:block">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold text-slate-500">
              <tr>
                <th scope="col" className="w-14 px-4 py-2.5">ID</th>
                <th scope="col" className="px-4 py-2.5">요건</th>
                <th scope="col" className="w-28 px-4 py-2.5">판정</th>
                <th scope="col" className="px-4 py-2.5">근거와 메모</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {jd.rows.map((row) => (
                <tr key={`${row.priority}-${row.requirement.id}`} className="break-inside-avoid align-top">
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{row.requirement.id}</td>
                  <td className="px-4 py-3">
                    <RequirementCell row={row} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill row={row} />
                  </td>
                  <td className="px-4 py-3">
                    <EvidenceCell row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {jd.untappedStrengths.length > 0 && (
        <div className="break-inside-avoid rounded-xl bg-indigo-50/60 p-5 ring-1 ring-inset ring-indigo-600/10">
          <h3 className="mb-2 text-sm font-semibold text-indigo-900">이력서에 있지만 JD와 연결하지 못한 강점</h3>
          <BulletList items={jd.untappedStrengths} />
        </div>
      )}
    </div>
  );
}
