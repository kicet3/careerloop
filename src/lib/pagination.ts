/**
 * 목록 쪽 나누기(클라이언트·서버 공용, 순수). 공고 보관함·공고 찾기는 한 쪽에 12개씩, 주소의 ?page=(1부터)로 쪽을 고른다.
 */
export const LIST_PAGE_SIZE = 12;
/** ?page= 상한(터무니없는 값으로 큰 OFFSET을 만들지 않게). 실제 쪽 수보다 크면 마지막 쪽으로 맞춘다. */
export const MAX_PAGE = 10_000;

/** ?page= 값 → 1 이상의 정수(틀리거나 없으면 1). */
export function parsePageParam(value: string | string[] | undefined | null): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,6}$/.test(raw.trim())) return 1;
  const n = Number(raw.trim());
  return n >= 1 ? Math.min(n, MAX_PAGE) : 1;
}

/** 전체 쪽 수(항목이 없어도 1쪽). */
export function pageCountOf(total: number, pageSize: number = LIST_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(total, 0) / Math.max(pageSize, 1)));
}

/** 쪽 번호를 1..쪽 수 안으로 맞춘다. */
export function clampPage(page: number, total: number, pageSize: number = LIST_PAGE_SIZE): number {
  const n = Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.min(Math.max(n, 1), pageCountOf(total, pageSize));
}

export interface PageInfo {
  /** 1부터. */
  page: number;
  pageCount: number;
  pageSize: number;
  /** 조건에 맞는 전체 항목 수. */
  total: number;
}

/**
 * 쪽 번호 줄: 처음·끝·현재 앞뒤 1쪽을 보이고 사이는 'gap'(…)으로 줄인다. 예) 현재 5/10 → 1 … 4 5 6 … 10.
 * 줄인 칸이 한 쪽뿐이면 그 번호를 그대로 보인다.
 */
export function pageItems(page: number, pageCount: number): (number | "gap")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const keep = new Set([1, pageCount, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pageCount));
  if (page <= 3) [2, 3, 4].forEach((n) => keep.add(n));
  if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((n) => keep.add(n));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && n - prev === 2) out.push(n - 1);
    else if (prev !== undefined && n - prev > 2) out.push("gap");
    out.push(n);
  });
  return out;
}
