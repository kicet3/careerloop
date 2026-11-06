"use client";
/**
 * 공고 URL 가져오기 작업(클라이언트): 시작(POST /api/postings/import, 본문 붙여넣기는 POST /api/postings/import/paste), 진행 중 작업 폴링(GET /import/[jobId]),
 * 새로 끝난 작업 알림(onCompleted). 보관함 목록·새 이력서의 '공고 링크로'·공고 상세의 '다시 가져오기'가 같이 쓴다.
 *
 * 끝난 작업 판별은 순수 함수(mergeImportResults)로 한다 — setState 갱신 함수 안에서 바깥 변수를 바꾸면
 * React가 갱신 함수를 나중(다음 렌더)에 부르므로 알림이 빠진다(예전 '새로고침해야 카드가 보임' 버그).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isPostingImportActive, type PostingImportJob } from "@/lib/domain/postings";
import { readApiError, type ApiError } from "./shared";

export const IMPORT_POLL_MS = 2000;

/** 화면용 작업: 공고 찾기에 있던 공고를 바로 담았으면 fromShared. */
export type ImportJobView = PostingImportJob & { fromShared?: boolean };

/**
 * 폴링 결과를 합친다. 결과가 없는(요청 실패) 작업은 그대로 두고, 이번에 completed가 된 작업을 따로 돌려준다.
 */
export function mergeImportResults<T extends PostingImportJob>(
  prev: T[],
  results: (PostingImportJob | null)[],
): { jobs: T[]; newlyCompleted: T[] } {
  const newlyCompleted: T[] = [];
  const jobs = prev.map((j) => {
    const next = results.find((r) => r?.id === j.id);
    if (!next) return j;
    const merged = { ...j, ...next };
    if (next.status === "completed" && j.status !== "completed") newlyCompleted.push(merged);
    return merged;
  });
  return { jobs, newlyCompleted };
}

/** 새 작업을 목록 맨 앞에(같은 id는 바꿔 끼운다). 최대 limit개. */
export function upsertImportJob<T extends PostingImportJob>(prev: T[], job: T, limit = 6): T[] {
  return [job, ...prev.filter((j) => j.id !== job.id)].slice(0, limit);
}

export type StartImportResult =
  | { ok: true; job: ImportJobView }
  /** existingId: 이미 보관함에 있는 공고(409). */
  | { ok: false; error: ApiError; status: number };

export interface StartImportOptions {
  /** '다시 가져오기'(링크 가져오기만). */
  refresh?: boolean;
  /** 본문 붙여넣어 가져오기: 페이지를 읽지 않고 이 본문(브라우저에서 복사한 공고 페이지 텍스트)으로 가져온다. */
  pageText?: string;
}

/** 가져오기 시작. 공고 찾기에 있던 공고면 job이 이미 completed(fromShared)다. */
export async function startPostingImport(url: string, opts: StartImportOptions = {}): Promise<StartImportResult> {
  try {
    const pasted = opts.pageText !== undefined;
    const res = await fetch(pasted ? "/api/postings/import/paste" : "/api/postings/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pasted ? { url, pageText: opts.pageText } : { url, ...(opts.refresh ? { refresh: true } : {}) }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await readApiError(res, "공고 가져오기를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.") };
    }
    const data = (await res.json()) as { job: PostingImportJob; fromShared?: boolean };
    return { ok: true, job: { ...data.job, fromShared: data.fromShared === true } };
  } catch {
    return { ok: false, status: 0, error: { error: "서버에 연결하지 못했습니다. 네트워크를 확인해 주세요." } };
  }
}

async function fetchImportJob(id: string): Promise<PostingImportJob | null> {
  try {
    const res = await fetch(`/api/postings/import/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { job: PostingImportJob }).job;
  } catch {
    return null;
  }
}

/**
 * 가져오기 작업 목록 상태. 진행 중 작업을 2초마다 폴링하고, 끝난 작업마다 onCompleted를 한 번 부른다
 * (시작하자마자 끝난 작업 — 공고 찾기 재사용 — 도 포함). 진행 중이던 작업이 실패로 끝나면 onFailed를 한 번 부른다
 * (리다이렉트 뒤 이미 보관한 공고로 밝혀진 경우 job.postingId에 기존 공고 id가 실린다).
 */
export function usePostingImports({
  initialJobs = [],
  onCompleted,
  onFailed,
}: {
  initialJobs?: ImportJobView[];
  onCompleted?: (job: ImportJobView) => void;
  onFailed?: (job: ImportJobView) => void;
}) {
  const [jobs, setJobs] = useState<ImportJobView[]>(initialJobs);
  const jobsRef = useRef(jobs);
  const onCompletedRef = useRef(onCompleted);
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
    onFailedRef.current = onFailed;
  }, [onCompleted, onFailed]);

  const commit = useCallback((next: ImportJobView[], completed: ImportJobView[]) => {
    const prev = jobsRef.current;
    jobsRef.current = next;
    setJobs(next);
    for (const j of completed) onCompletedRef.current?.(j);
    for (const j of next) {
      if (j.status !== "failed") continue;
      const before = prev.find((p) => p.id === j.id);
      if (before && before.status !== "failed") onFailedRef.current?.(j);
    }
  }, []);

  const activeIds = jobs
    .filter((j) => isPostingImportActive(j.status))
    .map((j) => j.id)
    .join(",");

  useEffect(() => {
    if (!activeIds) return;
    const ids = activeIds.split(",");
    let cancelled = false;
    let inFlight = false;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const results = await Promise.all(ids.map(fetchImportJob));
        if (cancelled) return;
        const { jobs: next, newlyCompleted } = mergeImportResults(jobsRef.current, results);
        commit(next, newlyCompleted);
      } finally {
        inFlight = false;
      }
    }, IMPORT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeIds, commit]);

  const start = useCallback(
    async (url: string, opts: StartImportOptions = {}): Promise<StartImportResult> => {
      const result = await startPostingImport(url, opts);
      if (result.ok) {
        const already = jobsRef.current.find((j) => j.id === result.job.id);
        const next = upsertImportJob(jobsRef.current, result.job);
        commit(next, result.job.status === "completed" && already?.status !== "completed" ? [result.job] : []);
      }
      return result;
    },
    [commit],
  );

  const dismiss = useCallback(
    (id: string) => commit(jobsRef.current.filter((j) => j.id !== id), []),
    [commit],
  );

  return { jobs, start, dismiss };
}
