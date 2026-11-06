"use client";
/**
 * 공고 보관함 목록: URL 가져오기(진행 중 카드 → 끝나면 지금 쪽을 서버에서 다시 읽어 공고 카드), 직접 추가(AI 엔진이 있으면 공고 원문을 붙여넣어
 * AI가 채워 바로 추가 — 링크 없는 본문 붙여넣기 가져오기 작업, 아래에 펼쳐 쓰는 직접 입력 폼), 검색·상태·정렬·마감 임박 필터,
 * 공고 카드(마감 배지·병역특례 태그). '공고 찾기'(공용 공고)는 사이드바의 별도 메뉴다. 직접 추가 입력은 공고 찾기의 '공고 추가'와 같은 PostingAddForms다.
 * 목록은 서버가 주소의 조건·쪽(?q=&status=&company=키&company=키&sort=&soon=1&page=)으로 한 쪽 12개를 읽어 준다(page.tsx → listPostingsPage).
 * '회사' 필터(CompanyFilter)는 내 공고의 회사(공백·법인 표기를 무시하고 묶은 회사 키)를 여러 개 고른다.
 * 조건을 바꾸면 1쪽 주소로 바꾸고(useUrlFilters), 쪽 이동 링크는 지금 조건을 그대로 싣는다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Pagination } from "@/components/ui/Pagination";
import {
  EMPLOYMENT_TYPE_LABELS,
  POSTING_STATUS_LABELS,
  POSTING_STATUSES,
  WORK_TYPE_LABELS,
  isPostingImportActive,
  type JobPostingSummary,
  type PostingImportJob,
} from "@/lib/domain/postings";
import type { CompanyOption } from "@/lib/domain/company";
import type { PageInfo } from "@/lib/pagination";
import { formatPostingDeadline } from "@/lib/postings/deadline";
import {
  DEFAULT_POSTING_SORT,
  EMPTY_POSTING_FILTERS,
  POSTING_SORT_LABELS,
  postingSearchParams,
  type PostingFilters,
  type PostingSort,
} from "@/lib/postings/filter";
import { safeSourceUrl } from "@/lib/postings/source-link";
import { platformLabel } from "@/lib/postings/url";
import { usePostingImports } from "./import-jobs";
import { MilitaryServiceBadges } from "./MilitaryServiceBadges";
import { PostingAddForms } from "./PostingAddForms";
import { CompanyFilter } from "./CompanyFilter";
import { ImportingCard, PostingImportBar } from "./PostingImportBar";
import { DeadlineBadge, inputClass, PostingStatusBadge, useNow } from "./shared";
import { SourceLink } from "./SourceLink";
import { useUrlFilters } from "./use-url-filters";

const LIBRARY_PATH = "/app/postings";

/** 주소에 싣는 화면 조건(검색·상태·마감 임박 + 정렬). */
type LibraryQuery = PostingFilters & { sort: PostingSort };
const libraryQuery = ({ sort, ...f }: LibraryQuery) => postingSearchParams(f, sort, 1);

export function PostingsView({
  list,
  filters,
  sort = DEFAULT_POSTING_SORT,
  companyOptions = [],
  initialImports,
  serverNow,
  aiAvailable = false,
}: {
  /** 지금 쪽(서버가 조건·쪽으로 읽은 12개)과 쪽 정보·전체 수. */
  list: { items: JobPostingSummary[]; allCount: number; activeCount: number; allStatusCount?: number } & PageInfo;
  /** 주소의 조건(입력칸 초기값). */
  filters: PostingFilters;
  sort?: PostingSort;
  /** '회사' 필터의 처음 목록(공고 수 많은 회사 + 고른 회사, 서버가 읽음). */
  companyOptions?: CompanyOption[];
  initialImports: PostingImportJob[];
  serverNow: number;
  aiAvailable?: boolean;
}) {
  const now = useNow(serverNow);
  const router = useRouter();
  const current: LibraryQuery = { ...filters, sort };
  const { draft, setDraft, set: setFilter, pending, startTransition } = useUrlFilters({ path: LIBRARY_PATH, filters: current, toQuery: libraryQuery });
  const [adding, setAdding] = useState(false);
  /** AI 추가를 시작한 뒤 화면 낭독기에 알리는 문구(항상 붙어 있는 라이브 영역). */
  const [announce, setAnnounce] = useState("");
  const addToggleRef = useRef<HTMLButtonElement>(null);

  // 진행 중 작업만 이어서 보여 준다(지난 완료·실패는 숨김). 작업이 끝나면 지금 쪽을 서버에서 다시 읽어 카드를 바로 넣는다.
  const [initialActive] = useState(() => initialImports.filter((j) => isPostingImportActive(j.status)));
  const imports = usePostingImports({ initialJobs: initialActive, onCompleted: () => startTransition(() => router.refresh()) });
  const importing = imports.jobs.filter((j) => isPostingImportActive(j.status));

  const { items: shown, allCount, activeCount, allStatusCount = 0, total, page, pageCount, pageSize } = list;
  // 기본 필터(진행 중)가 숨기는 마감·보류 공고 수. 모두 마감·보류면 기본 필터로 '초기화'해도 목록이 비므로 '모두'로 연다.
  const hiddenByDefault = allCount - activeCount;
  const isDefaultFilter =
    !filters.query.trim() && filters.status === EMPTY_POSTING_FILTERS.status && !filters.onlyClosingSoon && !filters.companies?.length;
  const resetFilters: PostingFilters = activeCount > 0 ? EMPTY_POSTING_FILTERS : { ...EMPTY_POSTING_FILTERS, status: "all" };
  const hrefFor = (n: number) => {
    const qs = postingSearchParams(filters, sort, n);
    return qs ? `${LIBRARY_PATH}?${qs}` : LIBRARY_PATH;
  };
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">공고 보관함</h1>
          <p className="mt-1 text-sm text-slate-500">관심 있는 채용 공고를 모아 두고 마감일·지원 상태를 관리합니다. {allCount}개</p>
        </div>
        <Button ref={addToggleRef} variant={adding ? "secondary" : "primary"} onClick={() => {
            setAnnounce("");
            setAdding((a) => !a);
          }}
          aria-expanded={adding}
        >
          {adding ? "추가 닫기" : "직접 추가"}
        </Button>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      <Card className="p-4 sm:p-5">
        <PostingImportBar jobs={imports.jobs} start={imports.start} dismiss={imports.dismiss} />
      </Card>

      {adding && (
        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-base font-semibold text-slate-900">공고 직접 추가</h2>
          {/* 원문 붙여넣기가 기본: 링크 가져오기와 같은 작업으로 시작해 진행 상황은 위 입력줄·목록의 가져오기 카드에 보인다. */}
          <PostingAddForms
            aiAvailable={aiAvailable}
            start={imports.start}
            onCancel={() => setAdding(false)}
            onPasteStarted={() => {
              setAdding(false);
              setAnnounce("공고 원문 분석을 시작했습니다. 진행 상황은 가져오기 목록에 표시됩니다.");
              // 누른 버튼이 추가 칸과 함께 사라지므로 포커스를 '직접 추가' 버튼으로 돌려놓는다.
              addToggleRef.current?.focus();
            }}
          />
        </Card>
      )}

      {allCount > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
          <CompanyFilter
            id="posting-company"
            endpoint="/api/postings/companies"
            value={draft.companies ?? []}
            onChange={(keys) => setFilter("companies", keys)}
            initialOptions={companyOptions}
            className="sm:col-span-2 lg:w-full"
          />
          <div className="sm:col-span-2 lg:min-w-64 lg:flex-1">
            <label htmlFor="posting-search" className="sr-only">
              검색
            </label>
            <input
              id="posting-search"
              type="search"
              value={draft.query}
              maxLength={100}
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
            value={draft.status}
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
          <select id="posting-sort" value={draft.sort} onChange={(e) => setFilter("sort", e.target.value as PostingSort)} className={cn(inputClass, "mt-0 lg:w-36")}>
            {(Object.keys(POSTING_SORT_LABELS) as PostingSort[]).map((s) => (
              <option key={s} value={s}>
                {POSTING_SORT_LABELS[s]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2 lg:col-span-1">
            <input
              type="checkbox"
              checked={draft.onlyClosingSoon}
              onChange={(e) => setFilter("onlyClosingSoon", e.target.checked)}
              className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            마감 7일 이내만
          </label>
        </div>
      )}

      {importing.length > 0 && (allCount === 0 || shown.length === 0) && (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
          {importing.map((j) => (
            <li key={j.id}>
              <ImportingCard job={j} />
            </li>
          ))}
        </ul>
      )}

      {allCount === 0 ? (
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
          ) : allStatusCount > 0 ? (
            <>
              {/* 진행 중 조건에서만 비었다(예: 마감·보류 공고뿐인 회사를 고름) — 다른 조건(회사 등)은 그대로 두고 상태만 넓힌다. */}
              <p className="text-sm text-slate-500">조건에 맞는 진행 중 공고가 없습니다. 마감·보류한 공고는 {allStatusCount}개 있습니다.</p>
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setFilter("status", "all")}>
                마감·보류 공고 {allStatusCount}개까지 보기
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500">조건에 맞는 공고가 없습니다.</p>
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setDraft({ ...resetFilters, sort: draft.sort })}>
                {activeCount > 0 ? "필터 초기화" : "필터 초기화(모든 공고 보기)"}
              </Button>
            </>
          )}
        </Card>
      ) : (
        <>
          <p className="relative z-10 text-sm text-slate-500" aria-live="polite">
            {total}개 중 {first}–{last}
            {pageCount > 1 ? ` · ${page}/${pageCount}쪽` : ""}
          </p>
          <ul className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4", pending && "opacity-60")} aria-busy={pending}>
            {/* 가져오는 중인 공고는 첫 쪽에만 보인다(끝나면 목록을 다시 읽어 제자리에 넣는다). */}
            {page === 1 &&
              importing.map((j) => (
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
          <Pagination
            page={page}
            pageCount={pageCount}
            hrefFor={hrefFor}
            onNavigate={(href) => startTransition(() => router.push(href))}
            label="공고 보관함 쪽 이동"
          />
        </>
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
        <MilitaryServiceBadges tags={p.militaryService} className="mt-2" />
      </Link>
      {/* 카드 링크 밖(형제)에 둔다 — <a> 안에 <a>를 넣지 않고, 눌러도 카드 상세로 이동하지 않는다. */}
      <SourceLink url={p.url} variant="icon" className="absolute right-2 bottom-2 sm:right-3 sm:bottom-3" />
    </div>
  );
}
