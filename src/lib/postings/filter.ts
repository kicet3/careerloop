/**
 * 공고 목록 검색·필터·정렬(클라이언트·서버 공용, 순수).
 * CareerLoop(src/lib/postings.ts filterPostings)에서 가져옴 — 이 제품에 없는 분류(모음·카테고리·회사 유형)는 뺐다.
 */
import { POSTING_STATUSES, type JobPostingSummary, type PostingStatus } from "@/lib/domain/postings";
import { parsePageParam } from "@/lib/pagination";
import { deadlineInfo, isClosingSoon, postingDeadlineAt, type DeadlineInfo } from "./deadline";

export type PostingSort = "deadline" | "updated" | "created" | "company";
export const POSTING_SORT_LABELS: Record<PostingSort, string> = {
  deadline: "마감 임박순",
  updated: "최근 수정순",
  created: "최근 추가순",
  company: "회사 이름순",
};

export interface PostingFilters {
  query: string;
  /** "active"는 마감·보류를 뺀 진행 중 공고. */
  status: PostingStatus | "all" | "active";
  onlyClosingSoon: boolean;
}

export const EMPTY_POSTING_FILTERS: PostingFilters = { query: "", status: "active", onlyClosingSoon: false };

type Row = Pick<
  JobPostingSummary,
  "id" | "company" | "roleTitle" | "location" | "note" | "url" | "status" | "deadline" | "deadlineTime" | "deadlineKind" | "createdAt" | "updatedAt"
>;

export function filterPostings<T extends Row>(items: readonly T[], filters: PostingFilters, sort: PostingSort = "deadline", now: number = Date.now()): T[] {
  const query = filters.query.trim().toLowerCase();
  const filtered = items.filter((p) => {
    if (filters.status === "active" && (p.status === "closed" || p.status === "on_hold")) return false;
    if (filters.status !== "all" && filters.status !== "active" && p.status !== filters.status) return false;
    if (query && ![p.company, p.roleTitle, p.location, p.note, p.url].join(" ").toLowerCase().includes(query)) return false;
    if (filters.onlyClosingSoon && !isClosingSoon(p, now)) return false;
    return true;
  });
  const byCompany = (a: T, b: T) => a.company.localeCompare(b.company, "ko");
  // 같은 값이면 id로 순서를 고정한다(쪽 나누기에서 쪽 사이에 겹치거나 빠지는 공고가 없게).
  const byId = (a: T, b: T) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  return filtered.sort((a, b) => {
    if (sort === "company") return byCompany(a, b) || byId(a, b);
    if (sort === "updated") return b.updatedAt - a.updatedAt || byId(a, b);
    if (sort === "created") return b.createdAt - a.createdAt || byId(a, b);
    // 마감 임박순: 마감이 남은 공고(시각까지 비교) → 마감일 없음 → 지난 공고.
    const rank = (info: DeadlineInfo) => (info.level === "none" ? 2 : info.level === "past" ? 3 : 1);
    return (
      rank(deadlineInfo(a, now)) - rank(deadlineInfo(b, now)) ||
      (postingDeadlineAt(a) ?? 0) - (postingDeadlineAt(b) ?? 0) ||
      byCompany(a, b) ||
      byId(a, b)
    );
  });
}

// ---------------------------------------------------------------------------
// 공고 보관함 주소(/app/postings?q=&status=&sort=&soon=1&page=)
// ---------------------------------------------------------------------------

export const DEFAULT_POSTING_SORT: PostingSort = "deadline";
const POSTING_SORTS = Object.keys(POSTING_SORT_LABELS) as PostingSort[];
const POSTING_STATUS_FILTERS: PostingFilters["status"][] = ["active", "all", ...POSTING_STATUSES];

type SearchParamsRecord = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** 보관함 주소 쿼리 → 검색 조건·정렬·쪽(1부터). 틀린 값은 기본값으로. */
export function parsePostingSearchParams(sp: SearchParamsRecord): { filters: PostingFilters; sort: PostingSort; page: number } {
  const status = first(sp.status);
  const sort = first(sp.sort);
  return {
    filters: {
      query: first(sp.q).trim().slice(0, 100),
      status: (POSTING_STATUS_FILTERS as string[]).includes(status) ? (status as PostingFilters["status"]) : EMPTY_POSTING_FILTERS.status,
      onlyClosingSoon: first(sp.soon) === "1",
    },
    sort: (POSTING_SORTS as string[]).includes(sort) ? (sort as PostingSort) : DEFAULT_POSTING_SORT,
    page: parsePageParam(sp.page),
  };
}

/** 검색 조건·정렬·쪽 → 보관함 주소 쿼리(기본값·1쪽은 싣지 않는다). parsePostingSearchParams와 짝. */
export function postingSearchParams(filters: PostingFilters, sort: PostingSort = DEFAULT_POSTING_SORT, page = 1): string {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.status !== EMPTY_POSTING_FILTERS.status) params.set("status", filters.status);
  if (sort !== DEFAULT_POSTING_SORT) params.set("sort", sort);
  if (filters.onlyClosingSoon) params.set("soon", "1");
  if (page > 1) params.set("page", String(page));
  return params.toString();
}
