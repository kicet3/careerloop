"use client";
/**
 * 그래프 이력서 에이전트 진행 화면. 단계 타임라인(단계별 요약), 라운드별 심사 점수표, 지금까지 가장 좋은 초안 미리 보기, 취소·다시 시도·빠른 초안.
 * 구역별 에이전트(pipelineVersion 2): 위는 총괄 타임라인(JD 분석 → 작전 → 구역 작성 → 조립 → 심사 → 피드백 …), 아래는 구역 카드 7개
 * (라운드별 칩: 대기·작성 중·완료·유지·실패→이전 결과 사용)와 라운드별 '총괄 피드백' 접이식. v1 작업은 예전 화면 그대로.
 * GET /api/resumes/agent-jobs/[id]를 2초(30초 뒤 5초) 간격으로 폴링하고 탭이 숨겨지면 멈춘다. needsKick이면 POST …/advance를
 * 한 번에 하나만 보낸다(연쇄가 막힌 배포의 안전망 — 서버는 리스가 비어 있을 때만 실행한다). 작업은 서버에서 계속되므로 화면을 떠나도 된다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { graphChatHref } from "@/components/graph/api";
import { markNotificationsReadByLink } from "@/components/notifications/store";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import {
  AGENT_STEP_LABELS,
  agentCompletedHref,
  agentHeading,
  STOP_REASON_LABELS,
  stepTitle,
  type AgentStepView,
  type OrchestratorFeedbackView,
  type ResumeAgentJobView,
  type SectionCardView,
  type SectionRoundView,
} from "@/lib/resume-agent/job-types";
import { formatElapsed } from "@/lib/resumes/draft-job-types";
import { AgentRoundScores } from "./AgentRoundScores";

export const AGENT_POLL_MS = 2000;
export const AGENT_POLL_SLOW_MS = 5000;
/** 이 시간이 지나면 폴링을 느리게. */
export const AGENT_POLL_SLOW_AFTER_MS = 30_000;

export function agentPollMs(elapsedMs: number, failures: number): number {
  const base = elapsedMs > AGENT_POLL_SLOW_AFTER_MS ? AGENT_POLL_SLOW_MS : AGENT_POLL_MS;
  return Math.min(30_000, base * 2 ** Math.max(0, Math.min(failures, 4)));
}

/** 상태 안내 문구(§4.4 UX 상태 표). */
export function agentStatusMessage(job: Pick<ResumeAgentJobView, "status" | "errorCode" | "chainEnabled" | "canRetry" | "stopReason">): string | null {
  switch (job.status) {
    case "waiting":
      return job.chainEnabled
        ? "다음 단계를 준비하고 있습니다. 화면을 닫아도 이어서 진행합니다."
        : "다음 단계를 준비하고 있습니다. 이 화면을 열어 두면 더 빨리 끝납니다(닫으면 다음에 앱을 열 때 이어서 진행합니다).";
    case "running":
      return "보통 8~15분 걸립니다. 이 화면을 떠나도 서버에서 계속 쓰고, 끝나면 상단 알림으로 알려 드립니다.";
    case "canceled":
      return "취소했습니다.";
    case "failed":
      if (job.errorCode === "insufficient_graph") return "경험이 거의 없어 쓸 수 있는 내용이 적습니다. 그래프 채팅으로 경험을 먼저 정리하거나 빠른 초안으로 만들어 주세요.";
      if (job.errorCode === "schema_version") return "서비스 업데이트로 다시 시작이 필요합니다.";
      if (!job.canRetry) return "작업 정보가 만료됐습니다 — 새로 만들어 주세요.";
      return null;
    case "completed":
      if (job.stopReason === "budget") return "비용 상한에 걸려 마지막 회차까지 다듬지 못했습니다.";
      if (job.stopReason === "review_failed") return "심사를 끝내지 못했습니다 — 진단에서 다시 심사할 수 있어요.";
      if (job.stopReason && job.stopReason !== "passed") return "목표 기준에는 못 미쳤습니다 — 리포트의 채울 정보를 답하면 올라갑니다.";
      return null;
  }
}

function stepLabel(s: AgentStepView): string {
  if (s.kind === "review" || s.kind === "revise") return stepTitle(s.kind, s.round);
  if (s.kind === "section" && !s.section) return s.round === 0 ? (s.status === "done" ? "구역 에이전트 작성" : "구역 에이전트들이 쓰는 중") : `지시받은 구역 다시 쓰기 ${s.round}회차`;
  if ((s.kind === "compose" || s.kind === "critique") && (s.round > 0 || s.status === "done")) return stepTitle(s.kind, s.round);
  return s.status === "done" ? AGENT_STEP_LABELS[s.kind].done : AGENT_STEP_LABELS[s.kind].label;
}

const CHIP: Record<SectionRoundView["status"], { text: string; className: string }> = {
  pending: { text: "대기", className: "bg-slate-100 text-slate-500" },
  running: { text: "작성 중", className: "bg-indigo-100 text-indigo-700" },
  done: { text: "완료", className: "bg-emerald-100 text-emerald-700" },
  failed: { text: "실패", className: "bg-rose-100 text-rose-700" },
  skipped: { text: "건너뜀", className: "bg-slate-100 text-slate-400" },
  kept: { text: "유지", className: "bg-slate-100 text-slate-600" },
};

function chipText(r: SectionRoundView): string {
  const base = r.round === 0 ? "초안" : `${r.round}회차`;
  if (r.status === "failed") return `${base} 실패 → 이전 결과 사용`;
  if (r.fallback && r.status === "done") return `${base} 완료(대체 작성)`;
  return `${base} ${CHIP[r.status].text}`;
}

/** 구역 카드 그리드(v2). @internal 테스트용으로 내보낸다. */
export function SectionCards({ sections }: { sections: readonly SectionCardView[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="구역 에이전트">
      {sections.map((c) => {
        const last = c.rounds.at(-1);
        // 요약은 내용이 있는 가장 최근 라운드(지금 쓰는 중이면 직전 결과).
        const shown = [...c.rounds].reverse().find((r) => r.summary.length > 0);
        const busy = c.rounds.some((r) => r.status === "running");
        return (
          <li key={c.section} className={cn("rounded-lg border p-3", c.skipped ? "border-slate-100 bg-slate-50" : "border-slate-200 bg-white")}>
            <div className="flex items-center justify-between gap-2">
              <p className={cn("text-sm font-semibold", c.skipped ? "text-slate-400" : "text-slate-900")}>
                {c.label}
                {busy && <Spinner size="sm" className="ml-1.5 inline-block align-[-2px]" />}
              </p>
              {last?.score !== null && last?.score !== undefined && <span className="text-xs text-slate-500 tabular-nums">총괄 점수 {last.score}</span>}
            </div>
            {c.skipped ? (
              <p className="mt-1 text-xs text-slate-400">이 이력서에는 쓰지 않습니다</p>
            ) : (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {c.rounds.map((r) => (
                    <span key={r.round} className={cn("rounded-full px-2 py-0.5 text-xs", r.status === "failed" ? CHIP.failed.className : r.fallback ? "bg-amber-100 text-amber-800" : CHIP[r.status].className)}>
                      {chipText(r)}
                    </span>
                  ))}
                </div>
                {shown && (
                  <ul className="mt-1.5 text-xs text-slate-500">
                    {shown.summary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 라운드별 총괄 피드백(접이식). @internal 테스트용. */
export function OrchestratorFeedback({ items }: { items: readonly OrchestratorFeedbackView[] }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-2">
      {items.map((o) => (
        <details key={o.round} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium text-slate-800">
            총괄 피드백 {o.round + 1}회차 — {o.summary}
          </summary>
          <ul className="mt-2 grid gap-1.5">
            {o.feedback.map((f) => (
              <li key={f.section}>
                <p className="text-xs font-semibold text-slate-700">{f.label}</p>
                <ul className="ml-3 list-disc text-xs text-slate-600">
                  {f.instructions.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

async function fetchJob(id: string): Promise<ResumeAgentJobView | "gone" | "signed-out" | null> {
  try {
    const res = await fetch(`/api/resumes/agent-jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (res.status === 404) return "gone";
    if (res.status === 401) return "signed-out";
    if (!res.ok) return null;
    return ((await res.json()) as { agentJob: ResumeAgentJobView }).agentJob;
  } catch {
    return null;
  }
}

export function AgentProgress({ initialJob, autoOpen = true }: { initialJob: ResumeAgentJobView; autoOpen?: boolean }) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState<null | "retry" | "single" | "cancel">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showPreview, setShowPreview] = useState(false);
  const kicking = useRef(false);
  const handled = useRef<string | null>(null);
  const active = job.status === "running" || job.status === "waiting";

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void poll(), agentPollMs(Date.now() - startedAt, failures));
    };
    const kick = async (id: string) => {
      if (kicking.current) return;
      kicking.current = true;
      try {
        await fetch(`/api/resumes/agent-jobs/${encodeURIComponent(id)}/advance`, { method: "POST" });
      } catch {
        // 다음 폴링에서 다시.
      } finally {
        kicking.current = false;
      }
    };
    const poll = async () => {
      // 탭이 숨겨지면 폴링을 멈춘다(돌아오면 다시).
      if (document.visibilityState !== "visible") return schedule();
      const next = await fetchJob(job.id);
      if (stopped) return;
      if (next === "signed-out") {
        router.push(`/login?next=/app/resumes/agent/${encodeURIComponent(job.id)}`);
        return;
      }
      if (next === "gone") return setGone(true);
      if (next === null) failures++;
      else {
        failures = 0;
        setJob(next);
        if (next.status !== "running" && next.status !== "waiting") return;
        if (next.needsKick) void kick(next.id);
      }
      schedule();
    };
    if (initialJob.needsKick) void kick(job.id);
    schedule();
    return () => {
      stopped = true;
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [active, job.id, router, initialJob.needsKick]);

  useEffect(() => {
    if (job.status !== "completed" || !job.resumeId || handled.current === job.id) return;
    handled.current = job.id;
    const href = agentCompletedHref(job) ?? `/app/resumes/${job.resumeId}?report=1`;
    void markNotificationsReadByLink([href, `/app/resumes/agent/${job.id}`]);
    if (autoOpen) router.replace(href);
  }, [job, autoOpen, router]);

  async function act(kind: "retry" | "single" | "cancel") {
    setBusy(kind);
    setActionError(null);
    const url =
      kind === "cancel"
        ? `/api/resumes/agent-jobs/${encodeURIComponent(job.id)}/cancel`
        : `/api/resumes/agent-jobs/${encodeURIComponent(job.id)}/retry${kind === "single" ? "?mode=single" : ""}`;
    try {
      const res = await fetch(url, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { agentJob?: ResumeAgentJobView; draftJob?: { id: string }; error?: string } | null;
      if (res.ok && data?.draftJob) {
        router.push(`/app/resumes/drafts/${encodeURIComponent(data.draftJob.id)}`);
        return;
      }
      if (res.ok && data?.agentJob) {
        setJob(data.agentJob);
        setNow(Date.now());
      } else setActionError(data?.error ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } catch {
      setActionError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  if (gone) {
    return (
      <Alert tone="error" title="에이전트 작업을 찾을 수 없습니다" className="mt-3 max-w-2xl">
        작업이 지워졌습니다.{" "}
        <Link href="/app/resumes" className="font-medium underline">
          이력서 목록
        </Link>
        에서 확인해 주세요.
      </Alert>
    );
  }

  const elapsed = (active ? now : (job.completedAt ?? job.updatedAt)) - job.startedAt;
  const message = agentStatusMessage(job);
  const chosen = job.rounds.length ? job.rounds.reduce((b, r) => (r.panelScore >= b.panelScore ? r : b)).round : null;

  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{agentHeading(job.status)}</h1>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">AI 에이전트 · JD 요건별 근거 + 심사위원 심사</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-slate-900">{job.label}</h2>
          </div>
          <p suppressHydrationWarning className="text-sm text-slate-500 tabular-nums" aria-label="경과 시간">
            {active && <Spinner size="sm" className="mr-1.5 inline-block align-[-2px]" />}
            {formatElapsed(elapsed)}
          </p>
        </div>

        <ol className="mt-6 grid gap-3" aria-label="진행 단계">
          {job.steps.map((s, i) => {
            const isCurrent = active && (s.key === job.currentStep || (s.kind === "section" && !s.section && job.currentStep.startsWith(`r${s.round}.sec.`))) && s.status !== "done";
            const state = s.status === "done" ? "done" : s.status === "failed" ? "failed" : isCurrent ? "active" : s.status === "skipped" ? "skipped" : "todo";
            return (
              <li key={s.key} className="flex gap-3" aria-current={state === "active" ? "step" : undefined}>
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
                    state === "done" && "bg-emerald-100 text-emerald-700",
                    state === "active" && "bg-indigo-600 text-white",
                    state === "failed" && "bg-rose-100 text-rose-700",
                    (state === "todo" || state === "skipped") && "bg-slate-100 text-slate-400",
                  )}
                >
                  {state === "done" ? "✓" : state === "failed" ? "!" : i + 1}
                </span>
                <div className="min-w-0">
                  <p className={cn("text-sm", state === "active" ? "font-semibold text-slate-900" : state === "failed" ? "font-medium text-rose-700" : state === "done" ? "text-slate-800" : "text-slate-400")}>
                    {stepLabel(s)}
                    {state === "active" && "…"}
                    {state === "skipped" && " (건너뜀)"}
                    <span className="sr-only">{state === "done" ? " (끝남)" : state === "active" ? " (진행 중)" : state === "failed" ? " (실패)" : " (대기)"}</span>
                  </p>
                  {s.summary.length > 0 && (
                    <ul className="mt-0.5 text-xs text-slate-500">
                      {s.summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {s.error && state !== "done" && <p className="mt-0.5 text-xs text-rose-700">{s.error}</p>}
                </div>
              </li>
            );
          })}
        </ol>

        {job.pipelineVersion === 2 && job.sections && (
          <div className="mt-6 border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">구역 에이전트</h3>
            <p className="mb-3 text-xs text-slate-500">구역마다 에이전트가 JD 분석과 내 경험 그래프만으로 쓰고, 총괄 에이전트가 심사 결과로 피드백한 구역만 다시 씁니다.</p>
            <SectionCards sections={job.sections} />
            {job.orchestrator && job.orchestrator.length > 0 && (
              <div className="mt-3">
                <OrchestratorFeedback items={job.orchestrator} />
              </div>
            )}
          </div>
        )}

        {(job.rounds.length > 0 || job.finalPanel) && (
          <div className="mt-6 border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">라운드별 심사 점수</h3>
            <AgentRoundScores rounds={job.rounds} finalPanel={job.finalPanel} chosenRound={chosen} />
            {job.stopReason && <p className="mt-2 text-xs text-slate-500">멈춘 이유: {STOP_REASON_LABELS[job.stopReason]}</p>}
          </div>
        )}

        {message && (
          <p className="mt-6 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600" role="status">
            {message}
          </p>
        )}

        {job.previewText && (
          <div className="mt-4">
            <button type="button" className="text-sm font-medium text-indigo-700 hover:underline" aria-expanded={showPreview} onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? "미리 보기 닫기 ▾" : "지금까지 가장 좋은 초안 미리 보기 ▸"}
            </button>
            {showPreview && <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 text-xs whitespace-pre-wrap text-slate-700">{job.previewText}</pre>}
          </div>
        )}

        {active && (
          <div className="mt-4">
            <Button type="button" size="sm" variant="secondary" loading={busy === "cancel"} onClick={() => void act("cancel")}>
              취소
            </Button>
            {actionError && (
              <p role="alert" className="mt-2 text-sm text-rose-700">
                {actionError}
              </p>
            )}
          </div>
        )}
      </Card>

      {job.status === "failed" && (
        <Alert tone="error" title="에이전트가 이력서를 끝내지 못했습니다">
          <p>{job.error ?? "잠시 후 다시 시도해 주세요."}</p>
          {actionError && <p className="mt-2 font-medium">{actionError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {job.canRetry && (
              <Button type="button" size="sm" loading={busy === "retry"} onClick={() => void act("retry")}>
                실패한 단계부터 다시
              </Button>
            )}
            {job.canFallback && (
              <Button type="button" size="sm" variant="secondary" loading={busy === "single"} onClick={() => void act("single")}>
                빠른 초안으로 만들기
              </Button>
            )}
            {job.errorCode === "insufficient_graph" && (
              <Link href={graphChatHref("이력서에 쓸 경력과 프로젝트를 정리하고 싶어요. 하나씩 물어봐 주세요.")} className={buttonClass("secondary", "sm")}>
                그래프 채팅으로 정리하기
              </Link>
            )}
            {job.regenerate && job.targetResumeId ? (
              <Link href={`/app/resumes/${job.targetResumeId}`} className={buttonClass("secondary", "sm")}>
                이력서로 돌아가기
              </Link>
            ) : (
              <Link href="/app/resumes/new" className={buttonClass("secondary", "sm")}>
                새 이력서 화면으로
              </Link>
            )}
          </div>
        </Alert>
      )}

      {job.status === "canceled" && (
        <Alert tone="info" title="취소했습니다">
          {actionError && <p className="mb-2 font-medium">{actionError}</p>}
          <div className="flex flex-wrap gap-2">
            {job.regenerate && job.targetResumeId ? (
              <Link href={`/app/resumes/${job.targetResumeId}`} className={buttonClass("primary", "sm")}>
                이력서로 돌아가기
              </Link>
            ) : (
              <Link href="/app/resumes/new" className={buttonClass("primary", "sm")}>
                새로 만들기
              </Link>
            )}
            {job.canFallback && (
              <Button type="button" size="sm" variant="secondary" loading={busy === "single"} onClick={() => void act("single")}>
                빠른 초안으로 만들기
              </Button>
            )}
          </div>
        </Alert>
      )}

      {job.status === "completed" && job.resumeId && (
        <Alert tone="info" title={job.regenerate ? "이력서를 다시 생성했습니다" : "이력서가 완성됐습니다"}>
          <p>{job.regenerate ? "새 버전으로 저장했습니다. 편집 화면으로 이동해 새 심사 리포트를 보여 드립니다." : "편집 화면으로 이동해 심사 리포트를 보여 드립니다."}</p>
          <Link href={agentCompletedHref(job) ?? `/app/resumes/${job.resumeId}?report=1`} className={cn(buttonClass("primary", "sm"), "mt-3")}>
            이력서·리포트 열기
          </Link>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/app/resumes" className="text-slate-500 hover:text-slate-800 hover:underline">
          이력서 목록으로
        </Link>
      </div>
    </div>
  );
}
