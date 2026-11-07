"use client";
/**
 * AI 이력서 초안 진행 화면. 단계(자료 모으는 중 → AI가 초안 쓰는 중 → 저장 중 → 완료)와 경과 시간을 보이고,
 * GET /api/resumes/drafts/[id]를 폴링한다. 끝나면 초안 메모를 편집 화면에 넘기고 편집 화면으로 옮긴다. 실패하면 문구와 '다시 시도'.
 * 초안은 서버의 백그라운드 작업이라 이 화면을 떠나도 계속된다 — 끝나면 상단 알림으로 알려 준다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { markNotificationsReadByLink } from "@/components/notifications/store";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { completedResumeHref, draftStepStates, formatElapsed, RESUME_DRAFT_STEP_LABELS, type ResumeDraftJobView } from "@/lib/resumes/draft-job-types";
import { saveDraftNotes } from "@/lib/resumes/prefill";

export const DRAFT_POLL_MS = 2500;

/** 연속으로 실패하면 폴링 간격을 이 값까지 늘린다. */
export const DRAFT_POLL_MAX_MS = 30_000;

/** 연속 실패 횟수에 따른 다음 폴링 간격(성공하면 DRAFT_POLL_MS, 실패할수록 두 배씩, DRAFT_POLL_MAX_MS까지). */
export function nextDraftPollMs(failures: number): number {
  return Math.min(DRAFT_POLL_MAX_MS, DRAFT_POLL_MS * 2 ** Math.max(0, Math.min(failures, 10)));
}

/** 진행 화면 제목(상태가 바뀌면 함께 바뀐다). */
export function draftHeading(status: ResumeDraftJobView["status"]): string {
  return status === "failed" ? "초안을 만들지 못했습니다" : status === "completed" ? "초안 완성" : "AI가 초안을 쓰고 있습니다";
}

/** 폴링 응답을 읽는다. 일시 오류(네트워크·5xx)는 null(다음 폴링에서 다시), 404는 'gone', 401은 'signed-out'. */
async function fetchJob(id: string): Promise<ResumeDraftJobView | "gone" | "signed-out" | null> {
  try {
    const res = await fetch(`/api/resumes/drafts/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (res.status === 404) return "gone";
    if (res.status === 401) return "signed-out";
    if (!res.ok) return null;
    return ((await res.json()) as { draftJob: ResumeDraftJobView }).draftJob;
  } catch {
    return null;
  }
}

export function DraftProgress({
  initialJob,
  autoOpen = true,
  agentFallback = false,
}: {
  initialJob: ResumeDraftJobView;
  autoOpen?: boolean;
  /** AI 에이전트를 골랐지만 쓸 수 없어 빠른 초안으로 만들었다(안내를 띄운다). */
  agentFallback?: boolean;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [gone, setGone] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const handled = useRef<string | null>(null);

  const running = job.status === "running";

  // 진행 중이면 폴링 + 1초마다 경과 시간. 폴링은 앞 요청이 끝난 뒤 다음을 건다(늦은 응답이 새 상태를 덮지 않게).
  // 연속으로 실패하면 간격을 늘리고, 세션이 끝났으면(401) 로그인 화면으로 보낸다.
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void poll(), nextDraftPollMs(failures));
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return schedule();
      const next = await fetchJob(job.id);
      if (stopped) return;
      if (next === "signed-out") {
        router.push(`/login?next=/app/resumes/drafts/${encodeURIComponent(job.id)}`);
        return;
      }
      if (next === "gone") return setGone(true);
      if (next === null) failures++;
      else {
        failures = 0;
        setJob(next);
        if (next.status !== "running") return;
      }
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [running, job.id, router]);

  // 완료: 메모를 넘기고 편집 화면으로. 이 화면에서 본 결과의 알림은 읽음으로.
  useEffect(() => {
    if (job.status !== "completed" || !job.resumeId || handled.current === job.id + job.resumeId) return;
    handled.current = job.id + job.resumeId;
    saveDraftNotes(job.resumeId, { notes: job.notes, missingInfo: job.missingInfo });
    const href = completedResumeHref(job) ?? `/app/resumes/${job.resumeId}`;
    void markNotificationsReadByLink([href, `/app/resumes/drafts/${job.id}`]);
    if (autoOpen) router.replace(href);
  }, [job, autoOpen, router]);

  useEffect(() => {
    if (job.status === "failed") void markNotificationsReadByLink([`/app/resumes/drafts/${job.id}`]);
  }, [job.status, job.id]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/resumes/drafts/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { draftJob?: ResumeDraftJobView; error?: string } | null;
      if (res.ok && data?.draftJob) {
        setJob(data.draftJob);
        setNow(Date.now());
      } else setRetryError(data?.error ?? "다시 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } catch {
      setRetryError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setRetrying(false);
    }
  }

  if (gone) {
    return (
      <div className="grid max-w-2xl gap-6">
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">초안 작업을 찾을 수 없습니다</h1>
        <Alert tone="error" title="초안 작업을 찾을 수 없습니다">
        작업이 지워졌습니다.{" "}
        <Link href="/app/resumes" className="font-medium underline">
          이력서 목록
        </Link>
        에서 확인해 주세요.
        </Alert>
      </div>
    );
  }

  const states = draftStepStates(job);
  const elapsed = (job.status === "running" ? now : (job.completedAt ?? job.updatedAt)) - job.startedAt;

  return (
    <div className="grid max-w-2xl gap-6">
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{draftHeading(job.status)}</h1>
      {agentFallback && (
        <Alert tone="info" title="빠른 초안으로 만들었습니다">
          AI 에이전트를 지금 쓸 수 없어(경험 그래프가 비어 있거나 에이전트가 꺼져 있음) 빠른 초안으로 만들었습니다. 심사위원 심사·수정 단계는 거치지 않습니다.
        </Alert>
      )}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">AI 이력서 초안</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-slate-900">{job.label}</h2>
          </div>
          <p suppressHydrationWarning className="text-sm text-slate-500 tabular-nums" aria-label="경과 시간">
            {running && <Spinner size="sm" className="mr-1.5 inline-block align-[-2px]" />}
            {formatElapsed(elapsed)}
          </p>
        </div>

        <ol className="mt-6 grid gap-3" aria-label="진행 단계">
          {RESUME_DRAFT_STEP_LABELS.map((step, i) => {
            const s = states[i]!;
            return (
              <li key={step.key} className="flex items-center gap-3" aria-current={s === "active" ? "step" : undefined}>
                <span
                  aria-hidden
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
                    s === "done" && "bg-emerald-100 text-emerald-700",
                    s === "active" && "bg-indigo-600 text-white",
                    s === "failed" && "bg-rose-100 text-rose-700",
                    s === "todo" && "bg-slate-100 text-slate-400",
                  )}
                >
                  {s === "done" ? "✓" : s === "failed" ? "!" : i + 1}
                </span>
                <span
                  className={cn(
                    "text-sm",
                    s === "active" ? "font-semibold text-slate-900" : s === "failed" ? "font-medium text-rose-700" : s === "done" ? "text-slate-700" : "text-slate-400",
                  )}
                >
                  {s === "done" ? step.done : step.label}
                  {s === "active" && "…"}
                  <span className="sr-only">{s === "done" ? " (끝남)" : s === "active" ? " (진행 중)" : s === "failed" ? " (실패)" : " (대기)"}</span>
                </span>
              </li>
            );
          })}
        </ol>

        {running && (
          <p className="mt-6 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600" role="status">
            초안은 보통 1~5분 걸립니다. 이 화면을 떠나도 서버에서 계속 쓰고, 끝나면 상단 <strong>알림</strong>으로 알려 드립니다.
          </p>
        )}
      </Card>

      {job.status === "failed" && (
        <Alert tone="error" title="초안을 만들지 못했습니다">
          <p>{job.error ?? "잠시 후 다시 시도해 주세요."}</p>
          {retryError && <p className="mt-2 font-medium">{retryError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {job.canRetry && (
              <Button type="button" size="sm" loading={retrying} onClick={() => void retry()}>
                다시 시도
              </Button>
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

      {job.status === "completed" && job.resumeId && (
        <Alert tone="info" title={job.regenerate ? "이력서를 다시 생성했습니다" : "초안이 완성됐습니다"}>
          <p>{job.regenerate ? "새 버전으로 저장했습니다. 편집 화면으로 이동합니다." : "편집 화면으로 이동합니다."}</p>
          <Link href={completedResumeHref(job) ?? `/app/resumes/${job.resumeId}`} className={cn(buttonClass("primary", "sm"), "mt-3")}>
            이력서 열기
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
