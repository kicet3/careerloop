"use client";
/**
 * 공고 URL 가져오기: 주소를 넣으면 POST /api/postings/import(202)로 작업을 만들고, 진행 중인 작업을 2초마다 폴링해
 * 단계(대기 → 공고 읽는 중 → AI 분석 중 → 완료/실패)를 보여 준다. 완료되면 onCompleted로 목록을 새로 읽게 한다.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { POSTING_IMPORT_STATUS_LABELS, isPostingImportActive, type PostingImportJob } from "@/lib/domain/postings";
import { inputClass, readApiError, type ApiError } from "./shared";

const POLL_MS = 2000;
const STEPS = ["queued", "reading", "analyzing", "completed"] as const;

export function PostingImportBar({ initialJobs, onCompleted }: { initialJobs: PostingImportJob[]; onCompleted: () => void }) {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // 최근 작업 중 진행 중이거나 이번에 시작한 것만 보인다(지난 실패는 숨김 — 닫기로 지울 수 있다).
  const [jobs, setJobs] = useState<PostingImportJob[]>(() => initialJobs.filter((j) => isPostingImportActive(j.status)));
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const activeIds = jobs.filter((j) => isPostingImportActive(j.status)).map((j) => j.id).join(",");

  const poll = useCallback(async (ids: string[]) => {
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const res = await fetch(`/api/postings/import/${id}`, { cache: "no-store" });
          if (!res.ok) return null;
          return ((await res.json()) as { job: PostingImportJob }).job;
        } catch {
          return null;
        }
      }),
    );
    let finished = false;
    setJobs((prev) =>
      prev.map((j) => {
        const next = results.find((r) => r?.id === j.id);
        if (next && next.status === "completed" && j.status !== "completed") finished = true;
        return next ?? j;
      }),
    );
    if (finished) onCompletedRef.current();
  }, []);

  useEffect(() => {
    if (!activeIds) return;
    const timer = setInterval(() => void poll(activeIds.split(",")), POLL_MS);
    return () => clearInterval(timer);
  }, [activeIds, poll]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const value = url.trim();
    if (!value) {
      setError({ error: "공고 상세 페이지 주소를 붙여넣으세요." });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/postings/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      if (!res.ok) {
        setError(await readApiError(res, "공고 가져오기를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        return;
      }
      const { job } = (await res.json()) as { job: PostingImportJob };
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)].slice(0, 6));
      setUrl("");
    } catch {
      setError({ error: "서버에 연결하지 못했습니다. 네트워크를 확인해 주세요." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
        <label htmlFor="posting-import-url" className="sr-only">
          공고 주소
        </label>
        <input
          id="posting-import-url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="채용 공고 상세 주소 붙여넣기 (원티드·사람인·잡코리아·회사 채용 페이지 등)"
          className={cn(inputClass, "mt-0 min-w-0 flex-1")}
        />
        <Button type="submit" loading={submitting} className="sm:h-[42px]">
          링크로 가져오기
        </Button>
      </form>
      <p className="text-xs text-slate-500">
        서버가 공개된 공고 페이지를 읽고 AI가 회사·직무·마감일을 정리합니다. 로그인해야 보이는 공고는 직접 추가하세요. 하루 20번까지.
      </p>
      {error && (
        <Alert tone="error">
          {error.error}
          {error.existingId && (
            <>
              {" "}
              <Link href={`/app/postings/${error.existingId}`} className="font-medium underline">
                기존 공고 열기
              </Link>
            </>
          )}
        </Alert>
      )}
      {jobs.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {jobs.map((job) => (
            <ImportRow key={job.id} job={job} onDismiss={() => setJobs((prev) => prev.filter((j) => j.id !== job.id))} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ImportRow({ job, onDismiss }: { job: PostingImportJob; onDismiss: () => void }) {
  const active = isPostingImportActive(job.status);
  const step = STEPS.indexOf(job.status as (typeof STEPS)[number]);
  return (
    <li
      className={cn(
        "rounded-lg border px-3 py-2.5 text-sm",
        job.status === "failed" ? "border-red-200 bg-red-50" : job.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white",
      )}
    >
      <div className="flex items-start gap-2">
        {active && <Spinner size="sm" className="mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-slate-500" title={job.url}>
            {job.url}
          </p>
          <p className={cn("mt-0.5 font-medium", job.status === "failed" ? "text-red-800" : "text-slate-900")}>
            {POSTING_IMPORT_STATUS_LABELS[job.status]}
            {job.error && <span className="font-normal"> — {job.error}</span>}
          </p>
          {active && (
            <div className="mt-2 flex gap-1" aria-hidden>
              {STEPS.slice(0, 3).map((s, i) => (
                <span key={s} className={cn("h-1 flex-1 rounded-full", i <= step ? "bg-indigo-500" : "bg-slate-200")} />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {job.postingId && (
            <Link href={`/app/postings/${job.postingId}`} className="font-medium text-indigo-700 hover:underline">
              {job.status === "completed" ? "열기" : "기존 공고"}
            </Link>
          )}
          {!active && (
            <button type="button" onClick={onDismiss} className="text-slate-400 hover:text-slate-700" aria-label="알림 닫기">
              ✕
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
