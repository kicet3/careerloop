/**
 * 공용 공고(공고 찾기) 응답 형태(클라이언트·서버 공용). 저장은 shared_postings(src/lib/postings/shared.ts).
 * URL 가져오기 결과와 직접 입력 공고의 공개 필드를 공유한다 — 누가 가져왔는지(만들었는지)·개인 메모·상태는 없다.
 */
import { z } from "zod";
import { parsePageParam } from "@/lib/pagination";
import { MILITARY_SERVICE_FILTERS, type MilitaryServiceFilter, type MilitaryServiceTag } from "./military-service";
import type { PostingCaptureInfo } from "./posting-capture";
import type { PostingHighlights, PostingStructure } from "./posting-structure";
import type { CareerLevel, DeadlineKind, EmploymentType, WorkType } from "./postings";

export interface SharedPostingSummary {
  id: string;
  /** 공고 페이지 주소. 직접 입력으로 만든 공용 공고는 null(원문 링크·다시 가져오기·캡처 없음). */
  url: string | null;
  urlKey: string | null;
  platform: string;
  company: string;
  roleTitle: string;
  deadline: string;
  deadlineTime: string;
  deadlineKind: DeadlineKind;
  employmentType: EmploymentType;
  workType: WorkType;
  location: string;
  careerLevel: CareerLevel;
  highlights?: PostingHighlights;
  /** 병역특례 태그(공개 필드로 판정, 없으면 []). 화면 문구는 militaryServiceLabels. */
  militaryService: MilitaryServiceTag[];
  /** 보관함에 담은 사용자 수. */
  importerCount: number;
  /** 페이지를 마지막으로 읽은 시각(ms). */
  fetchedAt: number;
  /** 보는 사용자의 보관함에 이미 있으면 그 공고 id. */
  myPostingId: string | null;
  /** 관리자가 숨긴 공고(관리자 화면에만 실린다). */
  hidden?: boolean;
  /** 원문 페이지 캡처 상태(이미지는 GET /api/shared-postings/[id]/capture). */
  capture?: PostingCaptureInfo;
}

export interface SharedPostingDetail extends SharedPostingSummary {
  jdText: string;
  structured: PostingStructure | null;
  sourceText: string;
  extractedBy: string;
}

/** 공고 찾기 마감 필터: 전체 / 마감 안 지남(상시·미공개 포함) / 7일 이내 마감. */
export const SHARED_DEADLINE_FILTERS = ["all", "open", "soon"] as const;
export type SharedDeadlineFilter = (typeof SHARED_DEADLINE_FILTERS)[number];
export const SHARED_DEADLINE_FILTER_LABELS: Record<SharedDeadlineFilter, string> = {
  all: "마감 전체",
  open: "마감 전(상시 포함)",
  soon: "7일 이내 마감",
};

const filterText = z.string().trim().max(100).optional().default("");

/** GET /api/shared-postings?q=&company=&role=&tech=&deadline=&military=&page= (page는 0부터 — 화면 주소의 ?page=는 1부터) */
export const SharedPostingListQuerySchema = z.object({
  /** 회사·직무·근무지·공고 본문 부분 일치. */
  q: filterText,
  company: filterText,
  role: filterText,
  /** 기술 스택(구역의 기술 칩 정확 일치 또는 본문 부분 일치). */
  tech: filterText,
  deadline: z.enum(SHARED_DEADLINE_FILTERS).optional().default("open"),
  /** 병역특례: all(거르지 않음)·any(종류 무관 가능)·expert·industrial. */
  military: z.enum(MILITARY_SERVICE_FILTERS).optional().default("all"),
  page: z.coerce.number().int().min(0).max(1000).optional().default(0),
  /** 'only'면 숨긴 공고만(관리자만 반영 — 일반 사용자는 무시). */
  hidden: z.enum(["only"]).optional(),
});
export type SharedPostingListQuery = z.infer<typeof SharedPostingListQuerySchema>;

/** GET /api/shared-postings 한 쪽 개수(외부 호출용 — 기존 값 유지). 화면(공고 찾기)은 LIST_PAGE_SIZE(12)로 따로 나눈다. */
export const SHARED_POSTING_PAGE_SIZE = 30;

/** 공고 찾기 화면(/app/postings/explore)의 검색 조건. 주소의 쿼리와 1:1로 맞는다(exploreSearchParams·parseExploreSearchParams). */
export interface ExploreFilters {
  q: string;
  company: string;
  role: string;
  tech: string;
  deadline: SharedDeadlineFilter;
  military: MilitaryServiceFilter;
  /** 관리자: 숨긴 공고만 보기(일반 사용자는 서버가 무시한다). */
  hiddenOnly?: boolean;
}

export const EMPTY_EXPLORE_FILTERS: ExploreFilters = { q: "", company: "", role: "", tech: "", deadline: "open", military: "all" };

type SearchParamsRecord = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const oneOf = <T extends string>(list: readonly T[], v: string, fallback: T): T => ((list as readonly string[]).includes(v) ? (v as T) : fallback);

/** 화면 주소의 쿼리 → 조건과 쪽(1부터). 틀린 값은 기본값으로(400을 내지 않는다). */
export function parseExploreSearchParams(sp: SearchParamsRecord): { filters: ExploreFilters; page: number } {
  const text = (k: string) => first(sp[k]).trim().slice(0, 100);
  return {
    filters: {
      q: text("q"),
      company: text("company"),
      role: text("role"),
      tech: text("tech"),
      deadline: oneOf(SHARED_DEADLINE_FILTERS, first(sp.deadline), "open"),
      military: oneOf(MILITARY_SERVICE_FILTERS, first(sp.military), "all"),
      ...(first(sp.hidden) === "only" ? { hiddenOnly: true } : {}),
    },
    page: parsePageParam(sp.page),
  };
}

/** 조건·쪽 → 화면 주소 쿼리(기본값·1쪽은 싣지 않는다). parseExploreSearchParams와 짝. */
export function exploreSearchParams(f: ExploreFilters, page = 1): string {
  const params = new URLSearchParams();
  for (const k of ["q", "company", "role", "tech"] as const) if (f[k].trim()) params.set(k, f[k].trim());
  if (f.deadline !== EMPTY_EXPLORE_FILTERS.deadline) params.set("deadline", f.deadline);
  if (f.military !== "all") params.set("military", f.military);
  if (f.hiddenOnly) params.set("hidden", "only");
  if (page > 1) params.set("page", String(page));
  return params.toString();
}
