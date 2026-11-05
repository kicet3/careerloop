"use client";
/**
 * 공고 URL 가져오기 입력줄: 주소를 넣으면 작업을 시작한다(상태·폴링은 부모의 usePostingImports).
 * - 진행 중 작업은 부모가 목록 맨 앞에 '가져오는 중' 카드(ImportingCard)로 보여 주고, 끝나면 그 자리에 공고 카드가 바로 나온다.
 * - 이 입력줄 아래에는 끝난 작업(완료 미리보기·실패 사유)만 보인다.
 * - 이미 보관한 공고(409)면 기존 공고 열기와 '다시 가져오기'(최신 내용으로 갱신)를 안내한다.
 * - 공고 찾기에 같은 공고가 있으면 AI 없이 바로 담긴다(완료 표시에 안내).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { POSTING_IMPORT_STATUS_LABELS, isPostingImportActive, type JobPosting } from "@/lib/domain/postings";
import type { ImportJobView, StartImportResult } from "./import-jobs";
import { DeadlineBadge, inputClass, type ApiError } from "./shared";

const STEPS = ["queued", "reading", "analyzing", "completed"] as const;

export function PostingImportBar({
  jobs,
  start,
  dismiss,
}: {
  jobs: ImportJobView[];
  start: (url: string, opts?: { refresh?: boolean }) => Promise<StartImportResult>;
  dismiss: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<(ApiError & { url?: string }) | null>(null);

  async function run(value: string, refresh: boolean) {
    setError(null);
    setSubmitting(true);
    try {
      const result = await start(value, { refresh });
      if (!result.ok) {
        setError({ ...result.error, url: value });
        return;
      }
      setUrl("");
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = url.trim();
    if (!value) {
      setError({ error: "공고 상세 페이지 주소를 붙여넣으세요." });
      return;
    }
    void run(value, false);
  }

  const finished = jobs.filter((j) => !isPostingImportActive(j.status));

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
        서버가 공개된 공고 페이지를 읽고 AI가 회사·직무·마감일과 업무·자격·우대·복지 등 구역을 원문 그대로 나눠 정리합니다. 로그인해야 보이는 공고는 직접 추가하세요. 하루 20번까지.
        링크로 가져온 공고 내용(메모·상태 제외)은 &lsquo;공고 찾기&rsquo;에 공유되고, 이미 누군가 가져온 링크는 AI 없이 바로 담깁니다.
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
              {error.url && (
                <>
                  {" · "}
                  <button type="button" className="font-medium underline" disabled={submitting} onClick={() => void run(error.url!, true)}>
                    다시 가져오기(최신 내용으로 갱신)
                  </button>
                </>
              )}
            </>
          )}
        </Alert>
      )}
      {finished.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {finished.map((job) => (
            <ImportRow key={job.id} job={job} onDismiss={() => dismiss(job.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** 목록 맨 앞의 '가져오는 중' 카드(공고 카드와 같은 크기). 끝나면 부모가 공고 카드로 바꾼다. */
export function ImportingCard({ job }: { job: ImportJobView }) {
  const step = STEPS.indexOf(job.status as (typeof STEPS)[number]);
  return (
    <div className="flex h-full flex-col rounded-xl border border-dashed border-indigo-300 bg-indigo-50/40 p-4 sm:p-5" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <Spinner size="sm" className="shrink-0" />
        <p className="font-semibold text-slate-900">{job.refresh ? "다시 가져오는 중" : "공고 가져오는 중"}</p>
      </div>
      <p className="mt-1 truncate text-sm text-slate-500" title={job.url}>
        {job.url}
      </p>
      <p className="mt-3 text-sm font-medium text-indigo-800">{POSTING_IMPORT_STATUS_LABELS[job.status]}</p>
      <div className="mt-2 flex gap-1" aria-hidden>
        {STEPS.slice(0, 3).map((s, i) => (
          <span key={s} className={cn("h-1 flex-1 rounded-full", i <= step ? "bg-indigo-500" : "bg-slate-200")} />
        ))}
      </div>
      <p className="mt-auto pt-3 text-xs text-slate-500">끝나면 이 자리에 공고 카드가 나타납니다. 다른 화면으로 가도 계속 진행됩니다.</p>
    </div>
  );
}

function ImportRow({ job, onDismiss }: { job: ImportJobView; onDismiss: () => void }) {
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
            {job.status === "completed" && job.fromShared && <span className="font-normal text-slate-600"> — 공고 찾기에 있던 공고를 바로 담았습니다</span>}
            {job.status === "completed" && job.refresh && <span className="font-normal text-slate-600"> — 최신 내용으로 갱신했습니다</span>}
          </p>
          {job.status === "completed" && job.postingId && <ImportPreview postingId={job.postingId} />}
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

/** 가져온 공고 미리보기(완료 뒤 한 번 읽는다). 읽지 못하면 아무것도 보이지 않는다(열기 링크는 따로 있다). */
function ImportPreview({ postingId }: { postingId: string }) {
  const [data, setData] = useState<{ posting: JobPosting; now: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/postings/${encodeURIComponent(postingId)}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { posting: JobPosting };
        if (!cancelled) setData({ posting: body.posting, now: Date.now() });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [postingId]);
  if (!data) return null;
  const { posting: p, now } = data;
  const s = p.structured;
  const counts = s
    ? ([
        ["업무", s.duties.length],
        ["자격", s.requirements.length],
        ["우대", s.preferred.length],
        ["복지", s.benefits.length],
      ] as const).filter(([, n]) => n > 0)
    : [];
  return (
    <div className="mt-2 rounded-md border border-emerald-100 bg-white/70 px-2.5 py-2">
      <p className="truncate font-medium text-slate-900">
        {p.company} · {p.roleTitle}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
        <DeadlineBadge posting={p} now={now} />
        {counts.length > 0 && <span>{counts.map(([k, n]) => `${k} ${n}`).join(" · ")}</span>}
        {s?.conditions.salary && (
          <Badge tone="positive" className="max-w-full">
            <span className="min-w-0 truncate" title={s.conditions.salary}>
              {s.conditions.salary}
            </span>
          </Badge>
        )}
      </div>
      {s && s.techStack.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.techStack.slice(0, 5).map((t) => (
            <Badge key={t} tone="accent" className="max-w-full">
              <span className="min-w-0 truncate" title={t}>
                {t}
              </span>
            </Badge>
          ))}
          {s.techStack.length > 5 && <Badge tone="accent">+{s.techStack.length - 5}</Badge>}
        </div>
      )}
    </div>
  );
}
