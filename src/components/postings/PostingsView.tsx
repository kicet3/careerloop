"use client";
/**
 * 공고 보관함 목록: URL 가져오기(진행 중 카드 → 끝나면 새로고침 없이 공고 카드), 직접 추가, 검색·상태·정렬·마감 임박 필터,
 * 공고 카드(마감 배지). '공고 찾기'(공용 공고)는 사이드바의 별도 메뉴다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import {
  EMPLOYMENT_TYPE_LABELS,
  POSTING_STATUS_LABELS,
  POSTING_STATUSES,
  WORK_TYPE_LABELS,
  isPostingImportActive,
  type JobPostingSummary,
  type PostingImportJob,
} from "@/lib/domain/postings";
import { formatPostingDeadline } from "@/lib/postings/deadline";
import { EMPTY_POSTING_FILTERS, filterPostings, POSTING_SORT_LABELS, type PostingFilters, type PostingSort } from "@/lib/postings/filter";
import { safeSourceUrl } from "@/lib/postings/source-link";
import { platformLabel } from "@/lib/postings/url";
import { PostingForm } from "./PostingForm";
import { usePostingImports } from "./import-jobs";
import { ImportingCard, PostingImportBar } from "./PostingImportBar";
import { DeadlineBadge, inputClass, PostingStatusBadge, useNow } from "./shared";
import { SourceLink } from "./SourceLink";

export function PostingsView({
  initialItems,
  initialImports,
  serverNow,
  aiAvailable = false,
}: {
  initialItems: JobPostingSummary[];
  initialImports: PostingImportJob[];
  serverNow: number;
  aiAvailable?: boolean;
}) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [items, setItems] = useState(initialItems);
  const [filters, setFilters] = useState<PostingFilters>(EMPTY_POSTING_FILTERS);
  const [sort, setSort] = useState<PostingSort>("deadline");
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/postings", { cache: "no-store" });
      if (res.ok) setItems(((await res.json()) as { items: JobPostingSummary[] }).items);
    } catch {
      // 다음 새로고침 때 다시 읽는다.
    }
  }, []);
  // 진행 중 작업만 이어서 보여 준다(지난 완료·실패는 숨김). 작업이 끝나면 목록을 다시 읽어 카드를 바로 넣는다.
  const [initialActive] = useState(() => initialImports.filter((j) => isPostingImportActive(j.status)));
  const imports = usePostingImports({ initialJobs: initialActive, onCompleted: () => void reload() });
  const importing = imports.jobs.filter((j) => isPostingImportActive(j.status));

  const shown = useMemo(() => filterPostings(items, filters, sort, now), [items, filters, sort, now]);
  // 기본 필터(진행 중)가 숨기는 마감·보류 공고 수. 모두 마감·보류면 기본 필터로 '초기화'해도 목록이 비므로 '모두'로 연다.
  const activeCount = useMemo(() => filterPostings(items, EMPTY_POSTING_FILTERS, sort, now).length, [items, sort, now]);
  const hiddenByDefault = items.length - activeCount;
  const isDefaultFilter = !filters.query.trim() && filters.status === EMPTY_POSTING_FILTERS.status && !filters.onlyClosingSoon;
  const resetFilters: PostingFilters = activeCount > 0 ? EMPTY_POSTING_FILTERS : { ...EMPTY_POSTING_FILTERS, status: "all" };
  const setFilter = <K extends keyof PostingFilters>(k: K, v: PostingFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">공고 보관함</h1>
          <p className="mt-1 text-sm text-slate-500">관심 있는 채용 공고를 모아 두고 마감일·지원 상태를 관리합니다. {items.length}개</p>
        </div>
        <Button variant={adding ? "secondary" : "primary"} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
          {adding ? "추가 닫기" : "직접 추가"}
        </Button>
      </div>

      <Card className="p-4 sm:p-5">
        <PostingImportBar jobs={imports.jobs} start={imports.start} dismiss={imports.dismiss} />
      </Card>

      {adding && (
        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-base font-semibold text-slate-900">공고 직접 추가</h2>
          <PostingForm
            aiAvailable={aiAvailable}
            onCancel={() => setAdding(false)}
            onSaved={(p, opts) => router.push(`/app/postings/${p.id}${opts.structure ? "?structure=1" : ""}`)}
          />
        </Card>
      )}

      {items.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
          <div className="sm:col-span-2 lg:min-w-64 lg:flex-1">
            <label htmlFor="posting-search" className="sr-only">
              검색
            </label>
            <input
              id="posting-search"
              type="search"
              value={filters.query}
              onChange={(e) => setFilter("query", e.target.value)}
              placeholder="회사·직무·근무지·메모 검색"
              className={cn(inputClass, "mt-0")}
            />
          </div>
          <label className="sr-only" htmlFor="posting-status">
            상태
          </label>
          <select
            id="posting-status"
            value={filters.status}
            onChange={(e) => setFilter("status", e.target.value as PostingFilters["status"])}
            className={cn(inputClass, "mt-0 lg:w-40")}
          >
            <option value="active">진행 중(마감·보류 제외)</option>
            <option value="all">전체 상태</option>
            {POSTING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {POSTING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="posting-sort">
            정렬
          </label>
          <select id="posting-sort" value={sort} onChange={(e) => setSort(e.target.value as PostingSort)} className={cn(inputClass, "mt-0 lg:w-36")}>
            {(Object.keys(POSTING_SORT_LABELS) as PostingSort[]).map((s) => (
              <option key={s} value={s}>
                {POSTING_SORT_LABELS[s]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2 lg:col-span-1">
            <input
              type="checkbox"
              checked={filters.onlyClosingSoon}
              onChange={(e) => setFilter("onlyClosingSoon", e.target.checked)}
              className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            마감 7일 이내만
          </label>
        </div>
      )}

      {importing.length > 0 && (items.length === 0 || shown.length === 0) && (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
          {importing.map((j) => (
            <li key={j.id}>
              <ImportingCard job={j} />
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 ? (
        importing.length > 0 ? null : (
        <Card className="px-6 py-14 text-center">
          <p className="text-lg font-semibold text-slate-900">아직 보관한 공고가 없습니다</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            위 칸에 공고 링크를 붙여넣거나 &lsquo;직접 추가&rsquo;로 회사·직무·마감일을 적어 두세요. 다른 사람이 가져온 공고는 &lsquo;공고 찾기&rsquo;에서 바로 담을 수 있습니다.
          </p>
          <Link href="/app/postings/explore" className="mt-4 inline-block text-sm font-medium text-indigo-700 hover:underline">
            공고 찾기 열기 →
          </Link>
        </Card>
        )
      ) : shown.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          {isDefaultFilter && hiddenByDefault > 0 ? (
            <>
              <p className="text-sm text-slate-500">
                진행 중인 공고가 없습니다. 마감·보류한 공고 {hiddenByDefault}개는 기본 목록에서 숨깁니다.
              </p>
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setFilter("status", "all")}>
                마감·보류 공고까지 보기
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500">조건에 맞는 공고가 없습니다.</p>
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setFilters(resetFilters)}>
                {activeCount > 0 ? "필터 초기화" : "필터 초기화(모든 공고 보기)"}
              </Button>
            </>
          )}
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
          {importing.map((j) => (
            <li key={j.id}>
              <ImportingCard job={j} />
            </li>
          ))}
          {shown.map((p) => (
            <li key={p.id}>
              <PostingCard posting={p} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PostingCard({ posting: p, now }: { posting: JobPostingSummary; now: number }) {
  const tags = [
    p.platform ? platformLabel(p.platform) : null,
    p.employmentType !== "unknown" ? EMPLOYMENT_TYPE_LABELS[p.employmentType] : null,
    p.workType !== "unknown" ? WORK_TYPE_LABELS[p.workType] : null,
    p.location || null,
  ].filter((t): t is string => !!t);
  const tech = p.highlights?.techStack ?? [];
  const salary = p.highlights?.salary ?? "";
  const hasSource = !!safeSourceUrl(p.url);
  return (
    <div className="relative h-full">
      <Link
        href={`/app/postings/${p.id}`}
        className={cn(
          "block h-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 sm:p-5",
          p.status === "closed" && "opacity-70",
          hasSource && "pb-11 sm:pb-12",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-slate-900">{p.company}</p>
            <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{p.roleTitle}</p>
          </div>
          <PostingStatusBadge status={p.status} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <DeadlineBadge posting={p} now={now} />
          {p.deadline && <span className="text-slate-500">{formatPostingDeadline(p)}</span>}
        </div>
        {(tags.length > 0 || !p.hasJd || tech.length > 0 || salary) && (
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
            {tech.slice(0, 3).map((t) => (
              <Badge key={`tech-${t}`} tone="accent" className="max-w-full">
                <span className="min-w-0 truncate" title={t}>
                  {t}
                </span>
              </Badge>
            ))}
            {tech.length > 3 && <Badge tone="accent">+{tech.length - 3}</Badge>}
            {!p.hasJd && <Badge tone="warning">JD 없음</Badge>}
          </div>
        )}
      </Link>
      {/* 카드 링크 밖(형제)에 둔다 — <a> 안에 <a>를 넣지 않고, 눌러도 카드 상세로 이동하지 않는다. */}
      <SourceLink url={p.url} variant="icon" className="absolute right-2 bottom-2 sm:right-3 sm:bottom-3" />
    </div>
  );
}
