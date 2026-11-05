"use client";

/**
 * 답변 연습: 텍스트 답변(+ 선택 타이머) → 제출(202) → 피드백 폴링 → 기준별 평가·모범 답변 개요·꼬리 질문. 지난 답변 이력도 본다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { formatDateTime } from "@/components/app/stages";
import { textareaClass } from "@/components/resumes/styles";
import {
  estimateSpokenSeconds,
  INTERVIEW_LIMITS,
  RECOMMENDED_ANSWER_SECONDS,
  type InterviewAnswerView,
  type InterviewQuestionView,
  type InterviewSourceLine,
} from "@/lib/domain/interview";
import { fetchAnswer, InterviewApiError, listAnswers, POLL_MS, retryAnswer, submitAnswer } from "./api";
import { FeedbackView } from "./FeedbackView";

export function PracticePanel({
  sessionId,
  question,
  linesById,
  latestAnswer,
  onAnswered,
}: {
  sessionId: string;
  question: InterviewQuestionView;
  linesById: Map<string, InterviewSourceLine>;
  latestAnswer: InterviewAnswerView | null;
  onAnswered: () => void;
}) {
  const [text, setText] = useState("");
  const [current, setCurrent] = useState<InterviewAnswerView | null>(latestAnswer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<InterviewAnswerView[] | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onAnsweredRef = useRef(onAnswered);
  useEffect(() => {
    onAnsweredRef.current = onAnswered;
  }, [onAnswered]);
  const rec = RECOMMENDED_ANSWER_SECONDS[question.category];
  const est = estimateSpokenSeconds(text);
  const pendingId = current?.status === "pending" ? current.id : null;

  // 타이머 표시(1초마다).
  useEffect(() => {
    if (startedAt == null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [startedAt]);
  const running = startedAt != null ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;

  // 피드백 폴링.
  useEffect(() => {
    if (!pendingId) return;
    const ctl = new AbortController();
    const t = window.setInterval(async () => {
      try {
        const { answer } = await fetchAnswer(pendingId, ctl.signal);
        if (answer.status !== "pending") {
          setCurrent(answer);
          setHistory(null);
          onAnsweredRef.current();
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError(err instanceof InterviewApiError ? err.message : "피드백을 확인하지 못했습니다.");
      }
    }, POLL_MS);
    return () => {
      ctl.abort();
      window.clearInterval(t);
    };
  }, [pendingId]);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await listAnswers(sessionId, question.id)).answers);
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "답변 기록을 불러오지 못했습니다.");
    }
  }, [sessionId, question.id]);

  function toggleTimer() {
    if (startedAt == null) {
      const t = Date.now();
      setStartedAt(t);
      setNow(t);
      setElapsed(null);
    } else {
      setElapsed(Math.min(INTERVIEW_LIMITS.durationSec, Math.round((Date.now() - startedAt) / 1000)));
      setStartedAt(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const answer = text.trim();
    if (!answer || busy || pendingId) return;
    setBusy(true);
    setError(null);
    const duration = startedAt != null ? Math.min(INTERVIEW_LIMITS.durationSec, Math.round((Date.now() - startedAt) / 1000)) : elapsed;
    setStartedAt(null);
    try {
      const res = await submitAnswer(sessionId, question.id, answer, duration);
      setCurrent(res.answer);
      setText("");
      setElapsed(null);
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "답변을 보내지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function retry(id: string) {
    setBusy(true);
    setError(null);
    try {
      setCurrent((await retryAnswer(id)).answer);
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "다시 요청하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-2">
        <label htmlFor={`answer-${question.id}`} className="block text-sm font-medium text-slate-800">
          내 답변 <span className="font-normal text-slate-500">(말하듯이 써 보세요. 결론 → 근거 → 한계)</span>
        </label>
        <textarea
          id={`answer-${question.id}`}
          ref={textareaRef}
          className={textareaClass}
          rows={6}
          maxLength={INTERVIEW_LIMITS.answerChars}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="예: [선택]이 맞다고 판단했습니다. [실제 자료]에서 [관찰]을 확인했고, … 다만 [한계]는 남아 [다음 조치]로 다뤘습니다."
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {text.length.toLocaleString()} / {INTERVIEW_LIMITS.answerChars.toLocaleString()}자 · 말하면 약 {est}초
            <span className={est > 0 && (est < rec.min || est > rec.max) ? " text-amber-700" : ""}>
              {" "}
              (권장 {rec.min}~{rec.max}초)
            </span>
          </span>
          <span className="flex items-center gap-2">
            {running != null && <span aria-live="polite">⏱ {running}초</span>}
            {running == null && elapsed != null && <span>잰 시간 {elapsed}초</span>}
            <Button size="sm" variant="ghost" onClick={toggleTimer}>
              {startedAt == null ? "시간 재기" : "멈추기"}
            </Button>
          </span>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" loading={busy} disabled={!text.trim() || !!pendingId}>
            피드백 받기
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (history ? setHistory(null) : void loadHistory())}
            disabled={question.attemptCount === 0 && !current}
          >
            {history ? "기록 닫기" : "지난 답변 보기"}
          </Button>
        </div>
      </form>

      {current?.status === "pending" && (
        <div className="flex items-center gap-2 text-sm text-slate-600" role="status">
          <Spinner size="sm" /> 답변을 읽고 피드백을 만드는 중입니다…
        </div>
      )}
      {current?.status === "failed" && (
        <Alert tone="error" title="피드백을 만들지 못했습니다">
          <p>{current.error ?? "잠시 후 다시 시도해 주세요."}</p>
          <Button className="mt-2" size="sm" variant="secondary" loading={busy} onClick={() => void retry(current.id)}>
            다시 받기
          </Button>
        </Alert>
      )}
      {current?.status === "done" && current.feedback && (
        <FeedbackView
          answer={current}
          feedback={current.feedback}
          linesById={linesById}
          onPracticeFollowUp={() => {
            setText("");
            textareaRef.current?.focus();
          }}
        />
      )}

      {history && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-800">답변 기록 {history.length}개</p>
          <ul className="space-y-2">
            {history.map((a) => (
              <li key={a.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500">
                  <time dateTime={new Date(a.createdAt).toISOString()}>{formatDateTime(a.createdAt)}</time>
                  <span>{a.status === "done" ? `${a.score ?? "–"}점` : a.status === "pending" ? "피드백 대기" : "실패"}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{a.answer}</p>
                {a.status === "done" && a.feedback && a.id !== current?.id && (
                  <button type="button" className="mt-1 text-xs font-medium text-indigo-700 hover:underline" onClick={() => setCurrent(a)}>
                    이 답변의 피드백 보기
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
