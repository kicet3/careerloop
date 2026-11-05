"use client";

/**
 * 면접 연습 세션 화면: 질문 생성 상태(폴링) → 진행률 요약 → 분류·별표·미연습 필터 → 질문 카드(근거 인용·꼬리 질문·연습).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { inputClass } from "@/components/resumes/styles";
import {
  INTERVIEW_CATEGORY_LABELS,
  INTERVIEW_QUESTION_CATEGORIES,
  type InterviewQuestionCategory,
  type InterviewQuestionView,
  type InterviewSessionDetail,
} from "@/lib/domain/interview";
import { computeProgress } from "@/lib/interview/source";
import { deleteSession, fetchSession, InterviewApiError, POLL_MS, regenerateSession, renameSession } from "./api";
import { QuestionCard } from "./QuestionCard";
import { SessionStatusBadge } from "./SessionList";

type CategoryFilter = "all" | InterviewQuestionCategory;

export function InterviewSessionView({ initial }: { initial: InterviewSessionDetail }) {
  const router = useRouter();
  const [detail, setDetail] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"regen" | "delete" | "rename" | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [hideSkipped, setHideSkipped] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const s = detail.session;
  const id = s.id;

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setDetail(await fetchSession(id, signal));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof InterviewApiError ? err.message : "연습을 불러오지 못했습니다.");
      }
    },
    [id],
  );

  // 질문을 만드는 동안 상태를 폴링한다.
  useEffect(() => {
    if (s.status !== "generating") return;
    const ctl = new AbortController();
    const t = window.setInterval(() => void reload(ctl.signal), POLL_MS);
    return () => {
      ctl.abort();
      window.clearInterval(t);
    };
  }, [s.status, reload]);

  const progress = useMemo(() => computeProgress(detail.questions), [detail.questions]);
  const linesById = useMemo(() => new Map(detail.sourceLines.map((l) => [l.id, l])), [detail.sourceLines]);
  const visible = detail.questions.filter(
    (q) =>
      (category === "all" || q.category === category) &&
      (!onlyStarred || q.starred) &&
      (!onlyNew || q.attemptCount === 0) &&
      (!hideSkipped || q.status !== "skipped" || openId === q.id),
  );

  function replaceQuestion(q: InterviewQuestionView) {
    setDetail((d) => ({ ...d, questions: d.questions.map((x) => (x.id === q.id ? q : x)) }));
  }

  async function regenerate() {
    const warn = s.status === "ready" ? " 새 질문이 만들어지면 지금 질문과 답변 기록은 바뀝니다." : "";
    if (!window.confirm(`같은 서류로 질문을 다시 만들까요?${warn}`)) return;
    setBusy("regen");
    setError(null);
    try {
      const { session } = await regenerateSession(id);
      setDetail((d) => ({ ...d, session }));
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "다시 만들지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm("이 면접 연습을 지울까요? 질문과 답변 기록이 모두 지워집니다.")) return;
    setBusy("delete");
    try {
      await deleteSession(id);
      router.push("/app/interview");
      router.refresh();
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "지우지 못했습니다.");
      setBusy(null);
    }
  }

  async function saveTitle() {
    const t = editingTitle?.trim();
    if (!t || t === s.title) return setEditingTitle(null);
    setBusy("rename");
    try {
      const { session } = await renameSession(id, t);
      setDetail((d) => ({ ...d, session }));
      setEditingTitle(null);
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "제목을 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/app/interview" className="text-sm text-slate-500 hover:text-indigo-700">
          ← 면접 연습 목록
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editingTitle !== null ? (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveTitle();
                }}
              >
                <input
                  aria-label="연습 제목"
                  className={cn(inputClass, "max-w-lg")}
                  value={editingTitle}
                  maxLength={120}
                  autoFocus
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setEditingTitle(null)}
                />
                <Button type="submit" size="md" loading={busy === "rename"}>
                  저장
                </Button>
                <Button variant="ghost" size="md" onClick={() => setEditingTitle(null)}>
                  취소
                </Button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">{s.title}</h1>
                <SessionStatusBadge status={s.status} />
                <button type="button" className="text-sm text-slate-500 hover:text-indigo-700" onClick={() => setEditingTitle(s.title)}>
                  제목 바꾸기
                </button>
              </div>
            )}
            <p className="mt-1 text-sm text-slate-500">
              {s.resumeId ? (
                <Link href={`/app/resumes/${s.resumeId}`} className="hover:text-indigo-700 hover:underline">
                  {s.resumeLabel}
                </Link>
              ) : (
                <span>{s.resumeLabel} (지운 이력서)</span>
              )}
              {s.targetLabel ? ` → ${s.targetLabel}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge>이력서</Badge>
              {s.hasPortfolio && <Badge>포트폴리오</Badge>}
              <Badge tone={s.hasPosting ? "accent" : "neutral"}>{s.hasPosting ? "채용 공고 반영" : "공고 없음 · 직무 일반 질문"}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={busy === "regen"} disabled={s.status === "generating"} onClick={regenerate}>
              질문 다시 만들기
            </Button>
            <Button variant="danger" size="sm" loading={busy === "delete"} onClick={remove}>
              지우기
            </Button>
          </div>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {s.status === "generating" && (
        <Card className="flex items-center gap-3 px-5 py-6 text-sm text-slate-700" role="status">
          <Spinner />
          <div>
            <p className="font-medium text-slate-900">서류를 읽고 예상 질문을 만드는 중입니다</p>
            <p className="mt-0.5 text-slate-500">보통 1~3분 걸립니다. 이 화면을 떠나도 계속 만들어집니다.</p>
          </div>
        </Card>
      )}
      {s.status === "failed" && (
        <Alert tone="error" title="질문을 만들지 못했습니다">
          <p>{s.error ?? "잠시 후 다시 시도해 주세요."}</p>
          <Button className="mt-3" size="sm" variant="secondary" loading={busy === "regen"} onClick={regenerate}>
            다시 만들기
          </Button>
        </Alert>
      )}

      {s.status === "ready" && detail.questions.length > 0 && (
        <>
          <ProgressSummary progress={progress} />
          <AnswerGuide />
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="질문 분류">
              <FilterChip active={category === "all"} onClick={() => setCategory("all")}>
                전체 {progress.total}
              </FilterChip>
              {INTERVIEW_QUESTION_CATEGORIES.filter((c) => progress.byCategory[c].total > 0).map((c) => (
                <FilterChip key={c} active={category === c} onClick={() => setCategory(c)}>
                  {INTERVIEW_CATEGORY_LABELS[c]} {progress.byCategory[c].total}
                </FilterChip>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-slate-700">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={onlyStarred} onChange={(e) => setOnlyStarred(e.target.checked)} /> 별표만
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> 아직 답하지 않은 질문만
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} /> 건너뛴 질문 숨기기
              </label>
            </div>
            {visible.length === 0 ? (
              <p className="text-sm text-slate-500">조건에 맞는 질문이 없습니다.</p>
            ) : (
              <ol className="space-y-3">
                {visible.map((q) => (
                  <li key={q.id}>
                    <QuestionCard
                      sessionId={id}
                      question={q}
                      linesById={linesById}
                      latestAnswer={detail.latestAnswers[q.id] ?? null}
                      open={openId === q.id}
                      onToggle={() => setOpenId((cur) => (cur === q.id ? null : q.id))}
                      onQuestionChange={replaceQuestion}
                      onAnswered={() => void reload()}
                    />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-sm ring-1 ring-inset transition-colors",
        active ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50",
      )}
    >
      {children}
    </button>
  );
}

function ProgressSummary({ progress }: { progress: ReturnType<typeof computeProgress> }) {
  const pct = progress.total ? Math.round((progress.practiced / progress.total) * 100) : 0;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">연습한 질문</p>
          <p className="text-2xl font-bold text-slate-900">
            {progress.practiced}
            <span className="text-base font-normal text-slate-500"> / {progress.total}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm text-slate-500">질문별 최고 점수 평균</p>
          <p className="text-2xl font-bold text-slate-900">{progress.averageBestScore ?? "–"}</p>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {INTERVIEW_QUESTION_CATEGORIES.filter((c) => progress.byCategory[c].total > 0).map((c) => (
          <div key={c} className="flex justify-between gap-2">
            <dt className="text-slate-500">{INTERVIEW_CATEGORY_LABELS[c]}</dt>
            <dd className="font-medium text-slate-800">
              {progress.byCategory[c].practiced}/{progress.byCategory[c].total}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** 답변 요령(가이드 7.3·7.7을 줄인 것). */
function AnswerGuide() {
  return (
    <details className="rounded-xl border border-indigo-100 bg-indigo-50/50 px-5 py-3 text-sm text-slate-700">
      <summary className="cursor-pointer font-medium text-indigo-900">답변 요령 — 짧게 답하되 근거는 깊게</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>질문받은 단계부터 답합니다: 결론 한 문장 → 가장 직접적인 근거 → 필요한 한계와 다음 조치.</li>
        <li>질문 하나에 프로젝트 전체를 처음부터 다시 설명하지 않습니다. 꼬리 질문 2개와 근거 3개를 준비해 두고 하나씩 꺼냅니다.</li>
        <li>경험 질문은 상황 → 과제 → 행동 → 결과, 의견 질문은 주장 → 이유 → 사례 → 주장으로 압축합니다.</li>
        <li>숫자가 기억나지 않으면 기억의 범위를 먼저 밝히고, 측정 방법과 확인할 자료를 말합니다. 근삿값을 지어내지 않습니다.</li>
        <li>팀 성과라면 전체 결과와 내가 분석·결정·만든 것을 나눠 말합니다.</li>
      </ul>
    </details>
  );
}
