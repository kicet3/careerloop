"use client";
/**
 * 이력서 목록 위 'AI 초안 만드는 중' 카드. 진행 중인 초안 작업과 최근 하루 안에 실패한 작업을 보인다(진행 화면 링크).
 * 진행 중인 작업이 있으면 GET /api/resumes/drafts를 폴링하고, 작업이 끝나면 목록을 새로 그린다(router.refresh — 새 이력서가 보인다).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { pokeNotifications } from "@/components/notifications/store";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { draftJobHref, formatElapsed, RESUME_DRAFT_STEP_LABELS, type ResumeDraftJobView } from "@/lib/resumes/draft-job-types";

export const DRAFT_LIST_POLL_MS = 4000;

/** 진행 중이던 작업 중 이번 결과에서 끝났거나(완료·실패) 사라진 것이 있는가. */
export function anyJobFinished(prev: readonly ResumeDraftJobView[], next: readonly ResumeDraftJobView[]): boolean {
  return prev.some((p) => p.status === "running" && next.find((n) => n.id === p.id)?.status !== "running");
}

export function DraftJobsStrip({ initialJobs }: { initialJobs: ResumeDraftJobView[] }) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const jobsRef = useRef(initialJobs);
  const [now, setNow] = useState(() => Date.now());
  const running = jobs.some((j) => j.status === "running");

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/resumes/drafts", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const next = ((await res.json()) as { items: ResumeDraftJobView[] }).items;
        const finished = anyJobFinished(jobsRef.current, next);
        jobsRef.current = next;
        setJobs(next);
        if (finished) {
          router.refresh();
          pokeNotifications();
        }
      } catch {
        // 다음 폴링에서 다시.
      }
    }, DRAFT_LIST_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [running, router]);

  if (jobs.length === 0) return null;
  return (
    <section aria-label="AI 초안 작업" className="space-y-2">
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {jobs.map((j) => {
          const failed = j.status === "failed";
          const step = j.stageLabel ?? RESUME_DRAFT_STEP_LABELS.find((s) => s.key === j.stage)?.label ?? "진행 중";
          const what = j.mode === "agent" ? "AI 에이전트" : "AI 초안";
          return (
            <li key={j.id}>
              <Link
                href={draftJobHref(j)}
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors",
                  failed ? "border-rose-200 bg-rose-50/60 hover:bg-rose-50" : "border-indigo-200 bg-indigo-50/60 hover:bg-indigo-50",
                )}
              >
                {failed ? (
                  <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-rose-100 text-xs font-bold text-rose-700">
                    !
                  </span>
                ) : (
                  <Spinner size="sm" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{j.label}</span>
                  <span suppressHydrationWarning className={cn("block text-xs", failed ? "text-rose-700" : "text-indigo-800")}>
                    {failed ? `${what} 실패 — 눌러서 다시 시도` : `${what} · ${step} · ${formatElapsed(now - j.startedAt)}`}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
