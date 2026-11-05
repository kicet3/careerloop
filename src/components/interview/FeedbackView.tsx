"use client";

/** 답변 피드백: 종합 점수, 5기준(근거·수치·본인 역할·길이·구조), 잘한 점·고칠 점, 서류에 없는 주장, 모범 답변 개요([ADD:] 강조), 꼬리 질문. */
import { Fragment } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  INTERVIEW_CRITERIA,
  INTERVIEW_CRITERIA_LABELS,
  type InterviewAnswerView,
  type InterviewFeedback,
  type InterviewSourceLine,
} from "@/lib/domain/interview";

/** [ADD: …] 자리표시를 눈에 띄게(직접 채워야 할 사실). */
export function WithPlaceholders({ text }: { text: string }) {
  const parts = text.split(/(\[ADD:[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\[ADD:/.test(p) ? (
          <mark key={i} className="rounded bg-amber-100 px-1 text-amber-900">
            {p}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

const scoreTone = (n: number) => (n >= 80 ? "positive" : n >= 60 ? "accent" : n >= 40 ? "warning" : "negative");

export function FeedbackView({
  answer,
  feedback: f,
  linesById,
  onPracticeFollowUp,
}: {
  answer: InterviewAnswerView;
  feedback: InterviewFeedback;
  linesById: Map<string, InterviewSourceLine>;
  onPracticeFollowUp: () => void;
}) {
  return (
    <section aria-label="답변 피드백" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-slate-900">피드백</p>
          <Badge tone={scoreTone(f.overall)}>{f.overall}점</Badge>
        </div>
        <p className="text-xs text-slate-500">
          약 {f.estimatedSeconds}초 분량 · 권장 {f.recommendedSeconds.min}~{f.recommendedSeconds.max}초
          {answer.durationSec != null ? ` · 잰 시간 ${answer.durationSec}초` : ""}
        </p>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-slate-500">내 답변 보기</summary>
        <p className="mt-1 whitespace-pre-wrap text-slate-700">{answer.answer}</p>
      </details>

      <ul className="space-y-2">
        {INTERVIEW_CRITERIA.map((k) => {
          const c = f.criteria[k];
          return (
            <li key={k} className="text-sm">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 font-medium text-slate-800">{INTERVIEW_CRITERIA_LABELS[k]}</span>
                <span className="flex gap-0.5" aria-label={`${c.score}/5`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n} className={cn("h-2 w-5 rounded-full", n <= c.score ? (c.score >= 4 ? "bg-emerald-500" : c.score >= 3 ? "bg-indigo-500" : "bg-amber-500") : "bg-slate-200")} />
                  ))}
                </span>
                <span className="text-xs text-slate-500">{c.score}/5</span>
              </div>
              {c.comment && <p className="mt-0.5 pl-[5.5rem] text-slate-600">{c.comment}</p>}
            </li>
          );
        })}
      </ul>

      {(f.strengths.length > 0 || f.improvements.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {f.strengths.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-emerald-700">잘한 점</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
                {f.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {f.improvements.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-amber-700">고칠 점</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">
                {f.improvements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {f.unsupportedClaims.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-medium">서류에서 확인되지 않는 내용 — 면접 전에 근거를 준비하세요</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {f.unsupportedClaims.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 text-sm">
        <p className="font-semibold text-indigo-900">모범 답변 개요</p>
        <p className="mt-0.5 text-xs text-slate-500">내 서류와 답변에 있는 사실로만 만든 뼈대입니다. 노란 칸은 직접 확인해 채우세요.</p>
        <ol className="mt-2 space-y-1.5 text-slate-800">
          <li>
            <span className="font-medium text-slate-500">결론 · </span>
            <WithPlaceholders text={f.modelAnswer.conclusion} />
          </li>
          {f.modelAnswer.points.map((p, i) => {
            const line = p.ref ? linesById.get(p.ref) : undefined;
            return (
              <li key={i}>
                <span className="font-medium text-slate-500">근거 {i + 1} · </span>
                <WithPlaceholders text={p.text} />
                {line ? (
                  <span className="ml-1 text-xs text-indigo-700" title={line.text}>
                    ({line.label})
                  </span>
                ) : (
                  <span className="ml-1 text-xs text-slate-400">(답변에서)</span>
                )}
              </li>
            );
          })}
          {f.modelAnswer.limitation && (
            <li>
              <span className="font-medium text-slate-500">한계·다음 조치 · </span>
              <WithPlaceholders text={f.modelAnswer.limitation} />
            </li>
          )}
        </ol>
      </div>

      {f.followUp && (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div>
            <p className="text-xs font-semibold text-slate-500">면접관의 꼬리 질문</p>
            <p className="mt-0.5 text-slate-800">{f.followUp}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={onPracticeFollowUp}>
            고쳐서 다시 답하기
          </Button>
        </div>
      )}
    </section>
  );
}
