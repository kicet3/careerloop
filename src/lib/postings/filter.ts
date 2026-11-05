/**
 * 공고 목록 검색·필터·정렬(클라이언트·서버 공용, 순수).
 * CareerLoop(src/lib/postings.ts filterPostings)에서 가져옴 — 이 제품에 없는 분류(모음·카테고리·회사 유형)는 뺐다.
 */
import type { JobPostingSummary, PostingStatus } from "@/lib/domain/postings";
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
  "company" | "roleTitle" | "location" | "note" | "url" | "status" | "deadline" | "deadlineTime" | "deadlineKind" | "createdAt" | "updatedAt"
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
  return filtered.sort((a, b) => {
    if (sort === "company") return byCompany(a, b);
    if (sort === "updated") return b.updatedAt - a.updatedAt;
    if (sort === "created") return b.createdAt - a.createdAt;
    // 마감 임박순: 마감이 남은 공고(시각까지 비교) → 마감일 없음 → 지난 공고.
    const rank = (info: DeadlineInfo) => (info.level === "none" ? 2 : info.level === "past" ? 3 : 1);
    return (
      rank(deadlineInfo(a, now)) - rank(deadlineInfo(b, now)) ||
      (postingDeadlineAt(a) ?? 0) - (postingDeadlineAt(b) ?? 0) ||
      byCompany(a, b)
    );
  });
}
