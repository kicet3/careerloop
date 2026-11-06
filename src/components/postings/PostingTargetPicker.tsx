"use client";
/**
 * 지원할 자리 고르기: 내 보관함 공고 검색 / 공고 링크로 가져오기(끝나면 자동 선택, 이미 보관한 공고·공고 찾기의 공고는 바로 선택).
 * 고르는 방법(mode)은 부모가 정하고, 고른 공고(전체 JobPosting)를 onSelect로 돌려준다. 새 진단 폼이 쓴다.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { inputClass } from "@/components/resumes/styles";
import { usePostingImports } from "@/components/postings/import-jobs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { searchPostingOptions, type PostingPickOption } from "@/components/resumes/NewResumeForm";
import { isPostingImportActive, POSTING_IMPORT_STATUS_LABELS, POSTING_STATUS_LABELS, type JobPosting } from "@/lib/domain/postings";

export type PostingPickMode = "library" | "url";

export async function fetchPosting(id: string): Promise<JobPosting | null> {
  try {
    const res = await fetch(`/api/postings/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { posting: JobPosting }).posting;
  } catch {
    return null;
  }
}

export function toPickOption(p: Pick<JobPosting, "id" | "company" | "roleTitle" | "status" | "deadline" | "updatedAt">): PostingPickOption {
  return { id: p.id, company: p.company, roleTitle: p.roleTitle, status: p.status, deadline: p.deadline, updatedAt: p.updatedAt };
}

export function PostingTargetPicker({
  mode,
  options: initialOptions,
  onSelect,
  onBusyChange,
}: {
  mode: PostingPickMode;
  options: PostingPickOption[];
  onSelect: (posting: JobPosting, note: string | null) => void;
  /** 링크 가져오기가 진행 중이면 true(부모가 제출을 막는다). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [options, setOptions] = useState(initialOptions);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const results = useMemo(() => searchPostingOptions(options, query), [options, query]);

  async function chooseById(id: string, note: string | null): Promise<boolean> {
    setLoadingId(id);
    const p = await fetchPosting(id);
    setLoadingId(null);
    if (!p) {
      setError("공고를 읽지 못했습니다. 잠시 후 다시 시도해 주세요.");
      return false;
    }
    setOptions((prev) => [toPickOption(p), ...prev.filter((x) => x.id !== p.id)]);
    setError(null);
    onSelect(p, note);
    return true;
  }

  const imports = usePostingImports({
    onCompleted: (job) => {
      onBusyChange?.(false);
      if (job.postingId) void chooseById(job.postingId, job.fromShared ? "공고 찾기에 있던 공고를 보관함에 담고 골랐습니다." : "공고를 보관함에 담고 골랐습니다.");
    },
    // 리다이렉트 뒤 최종 주소가 이미 보관한 공고였으면 작업은 실패로 끝나고 postingId에 그 공고가 실린다 — 그 공고를 고른다.
    onFailed: (job) => {
      onBusyChange?.(false);
      if (!job.postingId) return;
      void chooseById(job.postingId, "이미 보관함에 있는 공고라 그 공고를 골랐습니다.").then((ok) => ok && imports.dismiss(job.id));
    },
  });
  const urlJob = imports.jobs[0];
  const importing = !!urlJob && isPostingImportActive(urlJob.status);

  // 사라질 때(방법을 바꾸거나 공고를 고름) 진행 중 표시를 풀어 준다 — 작업 상태는 이 컴포넌트에만 있어 부모가 영영 막히지 않게.
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  });
  useEffect(() => () => onBusyChangeRef.current?.(false), []);

  async function importUrl() {
    const value = url.trim();
    setError(null);
    if (!value) {
      setError("공고 상세 페이지 주소를 붙여넣으세요.");
      return;
    }
    const result = await imports.start(value);
    if (result.ok) {
      setUrl("");
      const { job } = result;
      // 바로 끝난 작업(공고 찾기에 있던 공고 등)은 start 안에서 onCompleted가 이미 불렸다 — 진행 중일 때만 막는다.
      if (isPostingImportActive(job.status)) onBusyChange?.(true);
      // 처음부터 실패로 돌아온 작업은 상태 변화가 없어 onFailed가 불리지 않는다 — 이미 보관한 공고면 여기서 고른다.
      else if (job.status === "failed" && job.postingId) {
        if (await chooseById(job.postingId, "이미 보관함에 있는 공고라 그 공고를 골랐습니다.")) imports.dismiss(job.id);
      }
      return;
    }
    if (result.error.existingId && (await chooseById(result.error.existingId, "이미 보관함에 있는 공고라 그 공고를 골랐습니다."))) {
      setUrl("");
      return;
    }
    setError(result.error.error);
  }

  if (mode === "library") {
    return (
      <div>
        <label htmlFor="target-posting-query" className="block text-sm font-medium text-slate-800">
          보관함 공고 검색
        </label>
        <input
          id="target-posting-query"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="회사·직무 검색"
          className={inputClass}
        />
        {options.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            보관한 공고가 없습니다. &lsquo;공고 링크로&rsquo;를 고르거나{" "}
            <Link href="/app/postings/explore" className="font-medium text-indigo-700 hover:underline">
              공고 찾기
            </Link>
            에서 공고를 담아 주세요.
          </p>
        ) : results.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">검색 결과가 없습니다.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={loadingId !== null}
                  onClick={() => void chooseById(p.id, null)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-indigo-50/50 disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-900">{p.company}</span>
                    <span className="block truncate text-xs text-slate-500">{p.roleTitle}</span>
                  </span>
                  {loadingId === p.id ? <Spinner size="sm" /> : <Badge tone="neutral">{POSTING_STATUS_LABELS[p.status]}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="target-posting-url" className="block text-sm font-medium text-slate-800">
        공고 링크
      </label>
      <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
        <input
          id="target-posting-url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!importing) void importUrl();
            }
          }}
          placeholder="채용 공고 상세 주소 붙여넣기"
          className={cn(inputClass, "mt-0 min-w-0 flex-1")}
        />
        <Button type="button" variant="secondary" loading={importing} disabled={importing} onClick={() => void importUrl()}>
          가져와서 고르기
        </Button>
      </div>
      <p className="mt-1.5 text-xs text-slate-500">
        이미 보관함에 있거나 공고 찾기에 있는 공고는 AI 없이 바로 고릅니다. 새 링크는 AI가 정리하는 데 30초~2분 걸립니다.
      </p>
      {importing && urlJob && (
        <p className="mt-2 flex items-center gap-2 text-sm text-indigo-800" role="status">
          <Spinner size="sm" /> {POSTING_IMPORT_STATUS_LABELS[urlJob.status]}…
        </p>
      )}
      {urlJob?.status === "failed" && !urlJob.postingId && <p className="mt-2 text-sm text-red-700">{urlJob.error ?? "공고를 가져오지 못했습니다."}</p>}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
