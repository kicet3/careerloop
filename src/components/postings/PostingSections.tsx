"use client";
/**
 * 구조화 공고의 구역 카드: 포지션 개요 → 주요 업무 → 자격 요건 → 우대 사항 → 기술 스택 → 근무 조건 → 복리후생 →
 * 채용 절차 → 제출 서류·지원 방법 → 회사 소개 → 기타. 빈 구역은 그리지 않고, 항목이 10개를 넘으면 '더 보기'로 접는다.
 * 핵심 정보 그리드(KeyFacts)는 상단 요약(회사·포지션·고용형태·근무형태·경력·근무지·마감·연봉).
 */
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { STRUCTURE_SECTION_LABELS as L, type PostingStructureEdit } from "@/lib/domain/posting-structure";
import { CAREER_LEVEL_LABELS, EMPLOYMENT_TYPE_LABELS, WORK_TYPE_LABELS, type JobPosting } from "@/lib/domain/postings";
import { formatPostingDeadline } from "@/lib/postings/deadline";
import { DeadlineBadge } from "./shared";

const FOLD_AT = 10;

/** 구역별 점 색(아이콘 대신 작은 원형 점). */
const DOT: Record<string, string> = {
  summary: "bg-slate-400",
  duties: "bg-indigo-500",
  requirements: "bg-rose-500",
  preferred: "bg-amber-500",
  techStack: "bg-violet-500",
  conditions: "bg-sky-500",
  benefits: "bg-emerald-500",
  process: "bg-cyan-600",
  application: "bg-teal-500",
  company: "bg-slate-500",
  notes: "bg-slate-300",
};

export function SectionCard({
  sectionKey,
  title,
  count,
  badge,
  children,
}: {
  sectionKey: string;
  title: string;
  count?: number;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = `posting-section-${sectionKey}`;
  return (
    <section aria-labelledby={id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", DOT[sectionKey] ?? "bg-slate-400")} />
        <h3 id={id} className="text-sm font-semibold text-slate-900">
          {title}
        </h3>
        {count !== undefined && count > 0 && <span className="text-xs text-slate-500">{count}개</span>}
        {badge}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function useFold<T>(items: T[]) {
  const [open, setOpen] = useState(false);
  const shown = open || items.length <= FOLD_AT ? items : items.slice(0, FOLD_AT);
  const toggle =
    items.length > FOLD_AT ? (
      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-sm font-medium text-indigo-700 hover:underline" aria-expanded={open}>
        {open ? "접기" : `더 보기 (${items.length - FOLD_AT}개)`}
      </button>
    ) : null;
  return { shown, toggle };
}

function BulletList({ items, columns = 1 }: { items: string[]; columns?: 1 | 2 }) {
  const { shown, toggle } = useFold(items);
  return (
    <>
      <ul className={cn("list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700", columns === 2 && "sm:grid sm:grid-cols-2 sm:gap-x-6 sm:space-y-0 sm:gap-y-1")}>
        {shown.map((l, i) => (
          <li key={i} className="break-words">
            {l}
          </li>
        ))}
      </ul>
      {toggle}
    </>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch">
      {items.map((step, i) => (
        <li key={i} className="flex min-w-0 items-start gap-2 sm:items-center">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-cyan-50 text-xs font-semibold text-cyan-800 ring-1 ring-cyan-200">
            {i + 1}
          </span>
          <span className="min-w-0 text-sm break-words text-slate-800">{step}</span>
          {i < items.length - 1 && (
            <span aria-hidden className="hidden text-slate-300 sm:inline">
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function DefList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="-mt-1.5 font-medium break-words text-slate-900 sm:mt-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 상단 핵심 정보. 값이 없거나 '미확인'인 칸은 숨긴다. */
export type KeyFactsPosting = Pick<
  JobPosting,
  "company" | "roleTitle" | "employmentType" | "workType" | "careerLevel" | "location" | "deadline" | "deadlineTime" | "deadlineKind"
>;

export function KeyFacts({ posting, salary, now }: { posting: KeyFactsPosting; salary: string; now: number }) {
  const facts: [string, React.ReactNode][] = [
    ["회사", posting.company],
    ["포지션", posting.roleTitle],
  ];
  if (posting.employmentType !== "unknown") facts.push(["고용형태", EMPLOYMENT_TYPE_LABELS[posting.employmentType]]);
  if (posting.workType !== "unknown") facts.push(["근무형태", WORK_TYPE_LABELS[posting.workType]]);
  if (posting.careerLevel !== "unknown") facts.push(["경력", CAREER_LEVEL_LABELS[posting.careerLevel]]);
  if (posting.location) facts.push(["근무지", posting.location]);
  facts.push([
    "마감",
    <span key="deadline" className="flex flex-wrap items-center gap-1.5">
      <DeadlineBadge posting={posting} now={now} />
      {posting.deadline && <span>{formatPostingDeadline(posting)}</span>}
    </span>,
  ]);
  if (salary) facts.push(["연봉", salary]);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
      {facts.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-medium text-slate-500">{k}</dt>
          <dd className="mt-0.5 text-sm font-semibold break-words text-slate-900">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 구역 카드 목록. 그릴 구역이 없으면 null. */
export function PostingSections({ structure, aiSummary }: { structure: PostingStructureEdit; aiSummary: boolean }) {
  const s = structure;
  const cards: React.ReactNode[] = [];
  if (s.summary) {
    cards.push(
      <SectionCard key="summary" sectionKey="summary" title={L.summary} badge={aiSummary ? <Badge tone="info">AI 요약</Badge> : undefined}>
        <p className="text-sm leading-relaxed break-words text-slate-800">{s.summary}</p>
      </SectionCard>,
    );
  }
  for (const key of ["duties", "requirements", "preferred"] as const) {
    if (s[key].length === 0) continue;
    cards.push(
      <SectionCard key={key} sectionKey={key} title={L[key]} count={s[key].length}>
        <BulletList items={s[key]} />
      </SectionCard>,
    );
  }
  if (s.techStack.length) {
    cards.push(
      <SectionCard key="tech" sectionKey="techStack" title={L.techStack} count={s.techStack.length}>
        <div className="flex flex-wrap gap-1.5">
          {s.techStack.map((t) => (
            <Badge key={t} tone="accent" className="max-w-full">
              <span className="min-w-0 truncate" title={t}>
                {t}
              </span>
            </Badge>
          ))}
        </div>
      </SectionCard>,
    );
  }
  const conditionRows: [string, string][] = [
    ...(s.conditions.salary ? [["연봉", s.conditions.salary] as [string, string]] : []),
    ...(s.conditions.workHours ? [["근무시간", s.conditions.workHours] as [string, string]] : []),
  ];
  if (conditionRows.length || s.conditions.other.length) {
    cards.push(
      <SectionCard key="conditions" sectionKey="conditions" title={L.conditions}>
        {conditionRows.length > 0 && <DefList rows={conditionRows} />}
        {s.conditions.other.length > 0 && (
          <div className={cn(conditionRows.length > 0 && "mt-3")}>
            <BulletList items={s.conditions.other} />
          </div>
        )}
      </SectionCard>,
    );
  }
  if (s.benefits.length) {
    cards.push(
      <SectionCard key="benefits" sectionKey="benefits" title={L.benefits} count={s.benefits.length}>
        <BulletList items={s.benefits} columns={2} />
      </SectionCard>,
    );
  }
  if (s.process.length) {
    cards.push(
      <SectionCard key="process" sectionKey="process" title={L.process} count={s.process.length}>
        <Steps items={s.process} />
      </SectionCard>,
    );
  }
  if (s.application.documents.length || s.application.method.length) {
    cards.push(
      <SectionCard key="application" sectionKey="application" title={L.application}>
        <div className="grid gap-4 sm:grid-cols-2">
          {s.application.documents.length > 0 && (
            <div className="min-w-0">
              <p className="mb-1 text-xs font-medium text-slate-500">제출 서류</p>
              <BulletList items={s.application.documents} />
            </div>
          )}
          {s.application.method.length > 0 && (
            <div className="min-w-0">
              <p className="mb-1 text-xs font-medium text-slate-500">지원 방법</p>
              <BulletList items={s.application.method} />
            </div>
          )}
        </div>
      </SectionCard>,
    );
  }
  if (s.company.industry || s.company.size || s.company.intro.length) {
    cards.push(
      <SectionCard key="company" sectionKey="company" title={L.company}>
        {(s.company.industry || s.company.size) && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {s.company.industry && <Badge className="max-w-full"><span className="min-w-0 truncate" title={s.company.industry}>업종 · {s.company.industry}</span></Badge>}
            {s.company.size && <Badge className="max-w-full"><span className="min-w-0 truncate" title={s.company.size}>규모 · {s.company.size}</span></Badge>}
          </div>
        )}
        <div className="space-y-1.5 text-sm leading-relaxed break-words text-slate-700">
          {s.company.intro.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </SectionCard>,
    );
  }
  if (s.notes.length) {
    cards.push(
      <SectionCard key="notes" sectionKey="notes" title={L.notes} count={s.notes.length}>
        <BulletList items={s.notes} />
      </SectionCard>,
    );
  }
  if (cards.length === 0) return null;
  return <div className="space-y-3">{cards}</div>;
}
