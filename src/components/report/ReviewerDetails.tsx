import type { ReactNode } from "react";
import type { ReviewerCard } from "@/lib/report/types";
import type { CheckedQuote } from "@/lib/report/types";
import { BulletList, Chip, EmptyState, QuoteBlock, VerdictBadge } from "./primitives";

function QuotedIssues({ items }: { items: { quote: CheckedQuote; issue: string }[] }) {
  return (
    <ul className="space-y-3">
      {items.map((x, i) => (
        <li key={i}>
          <QuoteBlock quote={x.quote} />
          <p className="mt-1.5 pl-1 text-sm leading-relaxed text-slate-600">{x.issue}</p>
        </li>
      ))}
    </ul>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-xs font-semibold text-slate-500">{children}</p>;
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={ok ? "text-emerald-700" : "text-rose-700"}>
      <span aria-hidden>{ok ? "✓" : "✕"}</span> {label}
    </span>
  );
}

function Detail({ card }: { card: ReviewerCard }) {
  const d = card.detail;
  if (d.kind === "ats") {
    const r = d.result;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Check ok={r.contactOk} label="연락처" />
          <Check ok={r.titlesAndDatesClear} label="직함·날짜 명확" />
        </div>
        {d.reasons.length > 0 && (
          <div>
            <Label>판정 사유</Label>
            <QuotedIssues items={d.reasons} />
          </div>
        )}
        {(r.keywordsPresent.length > 0 || r.keywordsMissing.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>찾은 키워드</Label>
              <div className="flex flex-wrap gap-1.5">
                {r.keywordsPresent.length ? r.keywordsPresent.map((k, i) => <Chip key={i} tone="positive">{k}</Chip>) : <span className="text-sm text-slate-400">없음</span>}
              </div>
            </div>
            <div>
              <Label>빠진 키워드</Label>
              <div className="flex flex-wrap gap-1.5">
                {r.keywordsMissing.length ? r.keywordsMissing.map((k, i) => <Chip key={i} tone="negative">{k}</Chip>) : <span className="text-sm text-slate-400">없음</span>}
              </div>
            </div>
          </div>
        )}
        {r.parseIssues.length > 0 && (
          <div>
            <Label>파싱 문제</Label>
            <BulletList items={r.parseIssues} />
          </div>
        )}
      </div>
    );
  }
  if (d.kind === "gatekeeper") {
    const r = d.result;
    return (
      <div className="space-y-4">
        <div>
          <Label>처음 10초</Label>
          <p className="text-sm leading-relaxed text-slate-700">{r.firstTenSeconds}</p>
        </div>
        {d.weakestLines.length > 0 && (
          <div>
            <Label>가장 약한 줄</Label>
            <QuotedIssues items={d.weakestLines} />
          </div>
        )}
        {r.interviewQuestions.length > 0 && (
          <div>
            <Label>면접에서 물어볼 질문</Label>
            <BulletList items={r.interviewQuestions} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <Label>가장 치명적인 한 줄</Label>
        <QuotedIssues items={[d.worstLine]} />
      </div>
      {d.result.otherProblems.length > 0 && (
        <div>
          <Label>다른 문제</Label>
          <BulletList items={d.result.otherProblems} />
        </div>
      )}
    </div>
  );
}

export function ReviewerDetails({ reviewers }: { reviewers: ReviewerCard[] }) {
  if (!reviewers.length) return <EmptyState>심사위원 결과가 아직 없습니다.</EmptyState>;
  return (
    <div className="space-y-4">
      {reviewers.map((card) => (
        <article key={card.id} id={`reviewer-${card.id}`} className="break-inside-avoid rounded-xl border border-slate-200 bg-white p-5 shadow-sm print:shadow-none">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="min-w-0">
              <h3 className="font-semibold text-slate-900">{card.name}</h3>
              <p className="mt-0.5 text-xs text-slate-500">{card.role}</p>
            </div>
            <VerdictBadge verdict={card.verdict} size="md" />
          </header>
          <p className="mt-3 text-sm font-medium leading-relaxed text-slate-800">{card.oneLiner}</p>
          <div className="mt-4">
            <Detail card={card} />
          </div>
        </article>
      ))}
    </div>
  );
}
