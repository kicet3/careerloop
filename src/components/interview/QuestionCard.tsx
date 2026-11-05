"use client";

/** 질문 카드: 분류·관점, 질문·의도, 근거 인용(서류 줄 펼쳐 보기), 꼬리 질문, 별표·건너뛰기, 연습 열기. */
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  INTERVIEW_CATEGORY_LABELS,
  INTERVIEW_FACET_LABELS,
  INTERVIEW_SOURCE_DOC_LABELS,
  RECOMMENDED_ANSWER_SECONDS,
  type InterviewAnswerView,
  type InterviewCitation,
  type InterviewQuestionView,
  type InterviewSourceLine,
} from "@/lib/domain/interview";
import { InterviewApiError, patchQuestion } from "./api";
import { PracticePanel } from "./PracticePanel";

const CATEGORY_TONE = { line: "accent", project: "info", pivot: "warning", tough: "negative", motivation: "positive", job: "neutral" } as const;

export function QuestionCard({
  sessionId,
  question: q,
  linesById,
  latestAnswer,
  open,
  onToggle,
  onQuestionChange,
  onAnswered,
}: {
  sessionId: string;
  question: InterviewQuestionView;
  linesById: Map<string, InterviewSourceLine>;
  latestAnswer: InterviewAnswerView | null;
  open: boolean;
  onToggle: () => void;
  onQuestionChange: (q: InterviewQuestionView) => void;
  onAnswered: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const rec = RECOMMENDED_ANSWER_SECONDS[q.category];
  const panelId = `practice-${q.id}`;

  async function patch(p: { starred?: boolean; status?: InterviewQuestionView["status"] }) {
    setError(null);
    onQuestionChange({ ...q, ...p });
    try {
      const { question } = await patchQuestion(sessionId, q.id, p);
      onQuestionChange(question);
    } catch (err) {
      onQuestionChange(q);
      setError(err instanceof InterviewApiError ? err.message : "바꾸지 못했습니다.");
    }
  }

  return (
    <article className={cn("rounded-xl border bg-white shadow-sm", open ? "border-indigo-300" : "border-slate-200", q.status === "skipped" && "opacity-70")}>
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-slate-400">Q{q.ord + 1}</span>
          <Badge tone={CATEGORY_TONE[q.category]}>{INTERVIEW_CATEGORY_LABELS[q.category]}</Badge>
          {q.facet && <Badge>{INTERVIEW_FACET_LABELS[q.facet] ?? q.facet}</Badge>}
          {q.attemptCount > 0 && (
            <Badge tone="positive">
              연습 {q.attemptCount}회{q.bestScore != null ? ` · 최고 ${q.bestScore}점` : ""}
            </Badge>
          )}
          {q.status === "skipped" && <Badge>건너뜀</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-pressed={q.starred}
              aria-label={q.starred ? "별표 빼기" : "별표 달기"}
              title={q.starred ? "별표 빼기" : "별표 달기"}
              onClick={() => void patch({ starred: !q.starred })}
              className={cn("rounded p-1 text-lg leading-none", q.starred ? "text-amber-500" : "text-slate-300 hover:text-slate-500")}
            >
              ★
            </button>
          </div>
        </div>
        <p className="mt-2 font-medium leading-relaxed text-slate-900">{q.question}</p>
        {q.intent && <p className="mt-1 text-sm text-slate-500">확인하려는 것: {q.intent}</p>}

        {q.citations.length > 0 && <Citations citations={q.citations} linesById={linesById} />}

        {q.followUps.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium text-slate-500">이어질 꼬리 질문</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
              {q.followUps.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant={open ? "secondary" : "primary"} aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
            {open ? "연습 닫기" : q.attemptCount > 0 ? "다시 연습하기" : "답변 연습하기"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void patch({ status: q.status === "skipped" ? (q.attemptCount > 0 ? "practiced" : "new") : "skipped" })}>
            {q.status === "skipped" ? "건너뛰기 취소" : "건너뛰기"}
          </Button>
          <span className="text-xs text-slate-400">
            권장 {rec.min}~{rec.max}초
          </span>
        </div>
      </div>
      {open && (
        <div id={panelId} className="border-t border-slate-100 bg-slate-50/60 p-4 sm:p-5">
          <PracticePanel sessionId={sessionId} question={q} linesById={linesById} latestAnswer={latestAnswer} onAnswered={onAnswered} />
        </div>
      )}
    </article>
  );
}

function Citations({ citations, linesById }: { citations: InterviewCitation[]; linesById: Map<string, InterviewSourceLine> }) {
  const [shown, setShown] = useState<string | null>(null);
  const line = shown ? linesById.get(shown) : undefined;
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-slate-500">근거가 된 서류</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {citations.map((c) => (
          <li key={c.ref}>
            <button
              type="button"
              aria-expanded={shown === c.ref}
              onClick={() => setShown((s) => (s === c.ref ? null : c.ref))}
              className={cn(
                "max-w-full rounded-md px-2 py-1 text-left text-xs ring-1 ring-inset",
                shown === c.ref ? "bg-indigo-50 text-indigo-900 ring-indigo-200" : "bg-slate-50 text-slate-700 ring-slate-200 hover:bg-slate-100",
              )}
            >
              <span className="font-semibold">{INTERVIEW_SOURCE_DOC_LABELS[c.doc]}</span> “{c.quote}”
              {!c.verified && <span className="ml-1 text-amber-700">(원문 확인 필요)</span>}
            </button>
          </li>
        ))}
      </ul>
      {shown && (
        <blockquote className="mt-2 border-l-2 border-indigo-300 pl-3 text-sm text-slate-700">
          {line ? (
            <>
              <p className="text-xs text-slate-500">{line.label}</p>
              <p className="mt-0.5 whitespace-pre-wrap">{line.text}</p>
            </>
          ) : (
            <p className="text-slate-500">원문 줄을 불러오지 못했습니다.</p>
          )}
        </blockquote>
      )}
    </div>
  );
}
