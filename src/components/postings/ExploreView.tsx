"use client";
/**
 * 공고 찾기(공용 공고 목록): 다른 사용자가 링크로 가져오거나 직접 입력한 공고를 회사·직무·기술·마감으로 거르고, AI 없이 내 보관함에 담는다.
 * 목록은 GET /api/shared-postings(필터가 바뀌면 0쪽부터, '더 보기'로 이어 읽기), 담기는 POST /api/shared-postings/[id]/save.
 * 개인 값(상태·메모·지원 기록)은 공유되지 않는다 — 이 화면에는 공고 페이지에서 뽑은 내용만 있다.
 * 오른쪽 위 '공고 추가'는 보관함과 같은 추가 입력(링크로 가져오기 PostingImportBar · 원문 붙여넣고 AI로 추가·직접 입력 PostingAddForms)을 이 화면에 펼친다.
 * 추가한 공고는 내 보관함에 들어가고(공유 규칙은 보관함과 같다), 가져오기가 끝나면 이 목록을 다시 읽는다.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import {
  EMPLOYMENT_TYPE_LABELS,
  WORK_TYPE_LABELS,
  isPostingImportActive,
  type JobPosting,
  type PostingImportJob,
} from "@/lib/domain/postings";
import {
  SHARED_DEADLINE_FILTER_LABELS,
  SHARED_DEADLINE_FILTERS,
  type SharedDeadlineFilter,
  type SharedPostingSummary,
} from "@/lib/domain/shared-postings";
import { formatPostingDeadline } from "@/lib/postings/deadline";
import { platformLabel } from "@/lib/postings/url";
import { usePostingImports } from "./import-jobs";
import { PostingAddForms } from "./PostingAddForms";
import { ImportingCard, PostingImportBar } from "./PostingImportBar";
import { DeadlineBadge, inputClass, readApiError, useNow } from "./shared";
import { SourceLink } from "./SourceLink";

export interface ExploreFilters {
  q: string;
  company: string;
  role: string;
  tech: string;
  deadline: SharedDeadlineFilter;
  /** 관리자: 숨긴 공고만 보기. */
  hiddenOnly?: boolean;
}

export const EMPTY_EXPLORE_FILTERS: ExploreFilters = { q: "", company: "", role: "", tech: "", deadline: "open" };

/** 목록 요청 주소(빈 조건은 싣지 않는다). */
export function exploreQueryString(f: ExploreFilters, page: number): string {
  const params = new URLSearchParams();
  for (const k of ["q", "company", "role", "tech"] as const) if (f[k].trim()) params.set(k, f[k].trim());
  params.set("deadline", f.deadline);
  if (f.hiddenOnly) params.set("hidden", "only");
  if (page > 0) params.set("page", String(page));
  return params.toString();
}

type ListResponse = { items: SharedPostingSummary[]; total: number };

export function ExploreView({
  initial,
  serverNow,
  isAdmin = false,
  initialImports = [],
  aiAvailable = false,
}: {
  initial: ListResponse;
  serverNow: number;
  isAdmin?: boolean;
  /** 최근 가져오기 작업(진행 중인 것만 이어서 보여 준다). */
  initialImports?: PostingImportJob[];
  /** AI 엔진이 있으면 '공고 추가'에 원문 붙여넣기(AI로 추가)가 기본으로 보인다. */
  aiAvailable?: boolean;
}) {
  const now = useNow(serverNow);
  const [adding, setAdding] = useState(false);
  /** 추가 작업을 시작·완료했을 때 화면 낭독기에 알리는 문구. */
  const [announce, setAnnounce] = useState("");
  const [filters, setFilters] = useState<ExploreFilters>(EMPTY_EXPLORE_FILTERS);
  const [items, setItems] = useState(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestNo = useRef(0);
  const firstRun = useRef(true);

  const load = useCallback(async (f: ExploreFilters, nextPage: number) => {
    const no = ++requestNo.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shared-postings?${exploreQueryString(f, nextPage)}`, { cache: "no-store" });
      if (no !== requestNo.current) return;
      if (!res.ok) {
        setError((await readApiError(res, "공고 목록을 불러오지 못했습니다.")).error);
        return;
      }
      const data = (await res.json()) as ListResponse;
      setItems((prev) => (nextPage === 0 ? data.items : [...prev, ...data.items.filter((i) => !prev.some((p) => p.id === i.id))]));
      setTotal(data.total);
      setPage(nextPage);
    } catch {
      if (no === requestNo.current) setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      if (no === requestNo.current) setLoading(false);
    }
  }, []);

  // 조건이 바뀌면 잠깐 기다렸다가 0쪽부터 다시 읽는다(첫 렌더는 서버가 준 목록).
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const timer = setTimeout(() => void load(filters, 0), 300);
    return () => clearTimeout(timer);
  }, [filters, load]);

  // 가져오기가 끝나면(내 보관함에 추가됨) 지금 조건으로 목록을 다시 읽는다 — 공유된 공고면 '보관함에서 열기'로 보인다.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  const [initialActive] = useState(() => initialImports.filter((j) => isPostingImportActive(j.status)));
  const imports = usePostingImports({
    initialJobs: initialActive,
    // 패널을 닫아 둔 채 끝나도 결과('추가 완료'·실패 줄)가 보이도록 패널을 다시 연다.
    onCompleted: () => {
      setAdding(true);
      setAnnounce("공고를 내 보관함에 추가했습니다. 공고 추가 패널의 '추가 완료'에서 열 수 있습니다.");
      void load(filtersRef.current, 0);
    },
    onFailed: (job) => {
      setAdding(true);
      setAnnounce(
        job.postingId
          ? "이미 내 보관함에 있는 공고입니다. 공고 추가 패널에서 기존 공고를 열 수 있습니다."
          : "공고를 가져오지 못했습니다. 공고 추가 패널에서 이유를 확인해 주세요.",
      );
    },
  });
  const importing = imports.jobs.filter((j) => isPostingImportActive(j.status));

  const setFilter = <K extends keyof ExploreFilters>(k: K, v: ExploreFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const onSaved = (id: string, postingId: string) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, myPostingId: postingId, importerCount: i.myPostingId ? i.importerCount : i.importerCount + 1 } : i)));
  const filtered = exploreQueryString(filters, 0) !== exploreQueryString(EMPTY_EXPLORE_FILTERS, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">공고 찾기</h1>
          <p className="mt-1 max-w-prose text-sm text-slate-500">
            CareerLoop 사용자들이 링크로 가져오거나 직접 입력한 공고입니다. 담으면 AI 분석 없이 바로 내 보관함에 들어가고, 상태·메모는 나만 봅니다. {total}개
          </p>
        </div>
        <Button
          variant={adding ? "secondary" : "primary"}
          onClick={() => {
            setAnnounce("");
            setAdding((a) => !a);
          }}
          aria-expanded={adding}
          aria-controls={adding ? "explore-add-panel" : undefined}
        >
          {adding ? "추가 닫기" : importing.length > 0 ? `공고 추가 (가져오는 중 ${importing.length})` : "공고 추가"}
        </Button>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {adding && (
        <ExploreAddPanel
          aiAvailable={aiAvailable}
          imports={imports}
          onCancel={() => setAdding(false)}
          onPasteStarted={() => setAnnounce("공고 원문 분석을 시작했습니다. 진행 상황은 위 링크로 가져오기 아래에 표시됩니다.")}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
        <FilterInput id="explore-q" label="검색" value={filters.q} onChange={(v) => setFilter("q", v)} placeholder="회사·직무·근무지·본문 검색" className="sm:col-span-2 lg:col-span-1" />
        <FilterInput id="explore-company" label="회사" value={filters.company} onChange={(v) => setFilter("company", v)} placeholder="회사" />
        <FilterInput id="explore-role" label="직무" value={filters.role} onChange={(v) => setFilter("role", v)} placeholder="직무" />
        <FilterInput id="explore-tech" label="기술" value={filters.tech} onChange={(v) => setFilter("tech", v)} placeholder="기술 (예: React)" />
        <div>
          <label htmlFor="explore-deadline" className="sr-only">
            마감
          </label>
          <select
            id="explore-deadline"
            value={filters.deadline}
            onChange={(e) => setFilter("deadline", e.target.value as SharedDeadlineFilter)}
            className={cn(inputClass, "mt-0 lg:w-44")}
          >
            {SHARED_DEADLINE_FILTERS.map((d) => (
              <option key={d} value={d}>
                {SHARED_DEADLINE_FILTER_LABELS[d]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {isAdmin && (
        <label className="-mt-3 flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={!!filters.hiddenOnly}
            onChange={(e) => setFilter("hiddenOnly", e.target.checked)}
            className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
          />
          관리자: 숨긴 공고만 보기(열어서 &lsquo;다시 공개&rsquo;할 수 있습니다)
        </label>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {items.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-lg font-semibold text-slate-900">{filtered ? "조건에 맞는 공고가 없습니다" : "아직 공유된 공고가 없습니다"}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            {filtered ? (
              "검색어를 줄이거나 마감 조건을 '마감 전체'로 바꿔 보세요."
            ) : (
              <>
                <Link href="/app/postings" className="font-medium text-indigo-700 hover:underline">
                  내 보관함
                </Link>
                에서 공고 링크를 가져오면 여기에 공유됩니다.
              </>
            )}
          </p>
          {filtered && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={() => setFilters(EMPTY_EXPLORE_FILTERS)}>
              조건 초기화
            </Button>
          )}
        </Card>
      ) : (
        <>
          <ul className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4", loading && page === 0 && "opacity-60")}>
            {items.map((p) => (
              <li key={p.id}>
                <SharedPostingCard posting={p} now={now} onSaved={onSaved} />
              </li>
            ))}
          </ul>
          {items.length < total && (
            <div className="flex justify-center">
              <Button variant="secondary" loading={loading} onClick={() => void load(filters, page + 1)}>
                더 보기 ({items.length}/{total})
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  className,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        maxLength={100}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(inputClass, "mt-0")}
      />
    </div>
  );
}

/** 공용 공고를 내 보관함에 담는다. 성공하면 내 공고 id. */
export async function saveSharedPosting(id: string): Promise<{ ok: true; postingId: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/shared-postings/${encodeURIComponent(id)}/save`, { method: "POST" });
    if (!res.ok) return { ok: false, error: (await readApiError(res, "보관함에 담지 못했습니다.")).error };
    const data = (await res.json()) as { posting: JobPosting };
    return { ok: true, postingId: data.posting.id };
  } catch {
    return { ok: false, error: "서버에 연결하지 못했습니다. 네트워크를 확인해 주세요." };
  }
}

function SharedPostingCard({
  posting: p,
  now,
  onSaved,
}: {
  posting: SharedPostingSummary;
  now: number;
  onSaved: (id: string, postingId: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tags = [
    p.platform ? platformLabel(p.platform) : null,
    p.employmentType !== "unknown" ? EMPLOYMENT_TYPE_LABELS[p.employmentType] : null,
    p.workType !== "unknown" ? WORK_TYPE_LABELS[p.workType] : null,
    p.location || null,
  ].filter((t): t is string => !!t);
  const tech = p.highlights?.techStack ?? [];
  const salary = p.highlights?.salary ?? "";

  async function save() {
    setSaving(true);
    setError(null);
    const result = await saveSharedPosting(p.id);
    setSaving(false);
    if (result.ok) onSaved(p.id, result.postingId);
    else setError(result.error);
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <Link href={`/app/postings/explore/${p.id}`} className="group block min-w-0">
        <p className="truncate font-semibold text-slate-900 group-hover:text-indigo-700">{p.company}</p>
        <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{p.roleTitle}</p>
      </Link>
      {p.hidden && (
        <Badge tone="warning" className="mt-2 self-start">
          숨김
        </Badge>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <DeadlineBadge posting={p} now={now} />
        {p.deadline && <span className="text-slate-500">{formatPostingDeadline(p)}</span>}
      </div>
      {(tags.length > 0 || tech.length > 0 || salary) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Badge key={t} className="max-w-full">
              <span className="min-w-0 truncate" title={t}>
                {t}
              </span>
            </Badge>
          ))}
          {salary && (
            <Badge tone="positive" className="max-w-full">
              <span className="min-w-0 truncate" title={salary}>
                {salary}
              </span>
            </Badge>
          )}
          {tech.slice(0, 4).map((t) => (
            <Badge key={`tech-${t}`} tone="accent" className="max-w-full">
              <span className="min-w-0 truncate" title={t}>
                {t}
              </span>
            </Badge>
          ))}
          {tech.length > 4 && <Badge tone="accent">+{tech.length - 4}</Badge>}
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-4">
        <span className="flex items-center gap-1 text-xs text-slate-500">
          <SourceLink url={p.url} variant="icon" className="-ml-1.5" />
          {p.importerCount > 0 ? `${p.importerCount}명이 담음` : "새 공고"}
        </span>
        {p.hidden ? null : p.myPostingId ? (
          <Link href={`/app/postings/${p.myPostingId}`} className={buttonClass("secondary", "sm")}>
            보관함에서 열기
          </Link>
        ) : (
          <Button size="sm" loading={saving} onClick={() => void save()}>
            내 보관함에 담기
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

/** '공고 추가' 패널 본문: 링크로 가져오기(진행 카드·완료/실패 줄 포함)와 원문 붙여넣기·직접 입력. 결과는 내 보관함에 들어간다. */
export function ExploreAddPanel({
  aiAvailable,
  imports,
  onCancel,
  onPasteStarted,
}: {
  aiAvailable: boolean;
  imports: Pick<ReturnType<typeof usePostingImports>, "jobs" | "start" | "dismiss">;
  onCancel: () => void;
  onPasteStarted: () => void;
}) {
  const importing = imports.jobs.filter((j) => isPostingImportActive(j.status));
  return (
    <Card id="explore-add-panel" className="space-y-5 p-5 sm:p-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">공고 추가</h2>
        <p className="mt-1 text-sm text-slate-500">
          추가한 공고는{" "}
          <Link href="/app/postings" className="font-medium text-indigo-700 hover:underline">
            내 보관함
          </Link>
          에 들어갑니다. 링크로 가져온 공고와 원문·직접 입력으로 만든 공고 내용은 보관함과 같은 규칙으로 공고 찾기에 공유됩니다(메모·상태 제외).
        </p>
      </div>
      <section aria-labelledby="explore-add-link">
        <h3 id="explore-add-link" className="mb-2 text-sm font-semibold text-slate-800">
          링크로 가져오기
        </h3>
        <PostingImportBar jobs={imports.jobs} start={imports.start} dismiss={imports.dismiss} />
        {importing.length > 0 && (
          <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {importing.map((j) => (
              <li key={j.id}>
                <ImportingCard job={j} hint="끝나면 위에 '추가 완료'로 표시되고 내 보관함에 들어갑니다. 다른 화면으로 가도 계속 진행됩니다." />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="explore-add-manual" className="border-t border-slate-200 pt-5">
        <h3 id="explore-add-manual" className="mb-3 text-sm font-semibold text-slate-800">
          {aiAvailable ? "원문 붙여넣기 · 직접 입력" : "직접 입력"}
        </h3>
        <PostingAddForms
          aiAvailable={aiAvailable}
          start={imports.start}
          onCancel={onCancel}
          onPasteStarted={onPasteStarted}
        />
      </section>
    </Card>
  );
}
