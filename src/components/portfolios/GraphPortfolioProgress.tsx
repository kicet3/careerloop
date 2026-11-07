"use client";
/**
 * 경험 그래프 포트폴리오 진행 화면. 단계(자료 모으는 중 → AI가 포트폴리오 쓰는 중 → 저장 중 → 완료)와 경과 시간을 보이고
 * GET /api/portfolios/graph/jobs/[id]를 폴링한다. 끝나면 포트폴리오 화면으로 옮긴다. 실패하면 문구와 '다시 시도'.
 * 작업은 서버의 백그라운드 작업이라 이 화면을 떠나도 계속된다 — 끝나면 상단 알림으로 알려 준다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { markNotificationsReadByLink } from "@/components/notifications/store";
import { nextDraftPollMs } from "@/components/resumes/DraftProgress";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { GRAPH_PORTFOLIO_STEP_LABELS, graphPortfolioStepStates, type GraphPortfolioJobView } from "@/lib/domain/graph-portfolio";
import { formatElapsed } from "@/lib/resumes/draft-job-types";

export function graphPortfolioHeading(job: Pick<GraphPortfolioJobView, "status" | "regenerate">): string {
  if (job.status === "failed") return "포트폴리오를 만들지 못했습니다";
  if (job.status === "completed") return job.regenerate ? "포트폴리오를 다시 만들었습니다" : "포트폴리오 완성";
  return job.regenerate ? "AI가 포트폴리오를 다시 쓰고 있습니다" : "AI가 포트폴리오를 쓰고 있습니다";
}

async function fetchJob(id: string): Promise<GraphPortfolioJobView | "gone" | "signed-out" | null> {
  try {
    const res = await fetch(`/api/portfolios/graph/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (res.status === 404) return "gone";
    if (res.status === 401) return "signed-out";
    if (!res.ok) return null;
    return ((await res.json()) as { job: GraphPortfolioJobView }).job;
  } catch {
    return null;
  }
}

export function GraphPortfolioProgress({ initialJob, autoOpen = true }: { initialJob: GraphPortfolioJobView; autoOpen?: boolean }) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [gone, setGone] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const handled = useRef<string | null>(null);
  const running = job.status === "running";

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
        router.push(`/login?next=/app/portfolios/drafts/${encodeURIComponent(job.id)}`);
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

  useEffect(() => {
    if (job.status !== "completed" || !job.portfolioId || handled.current === job.id + job.portfolioId) return;
    handled.current = job.id + job.portfolioId;
    void markNotificationsReadByLink([`/app/portfolios/${job.portfolioId}`, `/app/portfolios/drafts/${job.id}`]);
    if (autoOpen) router.replace(`/app/portfolios/${job.portfolioId}`);
  }, [job, autoOpen, router]);

  useEffect(() => {
    if (job.status === "failed") void markNotificationsReadByLink([`/app/portfolios/drafts/${job.id}`]);
  }, [job.status, job.id]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/portfolios/graph/jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { job?: GraphPortfolioJobView; error?: string } | null;
      if (res.ok && data?.job) {
        setJob(data.job);
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
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">포트폴리오 작업을 찾을 수 없습니다</h1>
        <Alert tone="error" title="포트폴리오 작업을 찾을 수 없습니다">
          작업이 지워졌습니다.{" "}
          <Link href="/app/portfolios" className="font-medium underline">
            포트폴리오 보관함
          </Link>
          에서 확인해 주세요.
        </Alert>
      </div>
    );
  }

  const states = graphPortfolioStepStates(job);
  const elapsed = (running ? now : (job.completedAt ?? job.updatedAt)) - job.startedAt;

  return (
    <div className="grid max-w-2xl gap-6">
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">{graphPortfolioHeading(job)}</h1>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-500">경험 그래프 포트폴리오</p>
            <h2 className="mt-0.5 truncate text-lg font-semibold text-slate-900">{job.label}</h2>
          </div>
          <p suppressHydrationWarning className="text-sm text-slate-500 tabular-nums" aria-label="경과 시간">
            {running && <Spinner size="sm" className="mr-1.5 inline-block align-[-2px]" />}
            {formatElapsed(elapsed)}
          </p>
        </div>

        <ol className="mt-6 grid gap-3" aria-label="진행 단계">
          {GRAPH_PORTFOLIO_STEP_LABELS.map((step, i) => {
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
            보통 1~5분 걸립니다. 이 화면을 떠나도 서버에서 계속 쓰고, 끝나면 상단 <strong>알림</strong>으로 알려 드립니다.
          </p>
        )}
      </Card>

      {job.status === "failed" && (
        <Alert tone="error" title="포트폴리오를 만들지 못했습니다">
          <p>{job.error ?? "잠시 후 다시 시도해 주세요."}</p>
          {retryError && <p className="mt-2 font-medium">{retryError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {job.canRetry && (
              <Button type="button" size="sm" loading={retrying} onClick={() => void retry()}>
                다시 시도
              </Button>
            )}
            <Link href="/app/portfolios?new=graph" className={buttonClass("secondary", "sm")}>
              새로 만들기
            </Link>
          </div>
        </Alert>
      )}

      {job.status === "completed" && job.portfolioId && (
        <Alert tone="info" title="포트폴리오가 완성됐습니다">
          <p>포트폴리오 화면으로 이동합니다.</p>
          <Link href={`/app/portfolios/${job.portfolioId}`} className={cn(buttonClass("primary", "sm"), "mt-3")}>
            포트폴리오 열기
          </Link>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/app/portfolios" className="text-slate-500 hover:text-slate-800 hover:underline">
          포트폴리오 보관함으로
        </Link>
      </div>
    </div>
  );
}
