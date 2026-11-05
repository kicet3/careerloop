/**
 * 공용 공고(공고 찾기) 응답 형태(클라이언트·서버 공용). 저장은 shared_postings(src/lib/postings/shared.ts).
 * URL 가져오기 결과만 공유한다 — 공고 페이지에서 뽑은 값만 있고 누가 가져왔는지·개인 메모·상태는 없다.
 */
import { z } from "zod";
import type { PostingHighlights, PostingStructure } from "./posting-structure";
import type { CareerLevel, DeadlineKind, EmploymentType, WorkType } from "./postings";

export interface SharedPostingSummary {
  id: string;
  url: string;
  urlKey: string;
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
  /** 보관함에 담은 사용자 수. */
  importerCount: number;
  /** 페이지를 마지막으로 읽은 시각(ms). */
  fetchedAt: number;
  /** 보는 사용자의 보관함에 이미 있으면 그 공고 id. */
  myPostingId: string | null;
  /** 관리자가 숨긴 공고(관리자 화면에만 실린다). */
  hidden?: boolean;
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

/** GET /api/shared-postings?q=&company=&role=&tech=&deadline=&page= */
export const SharedPostingListQuerySchema = z.object({
  /** 회사·직무·근무지·공고 본문 부분 일치. */
  q: filterText,
  company: filterText,
  role: filterText,
  /** 기술 스택(구역의 기술 칩 정확 일치 또는 본문 부분 일치). */
  tech: filterText,
  deadline: z.enum(SHARED_DEADLINE_FILTERS).optional().default("open"),
  page: z.coerce.number().int().min(0).max(1000).optional().default(0),
  /** 'only'면 숨긴 공고만(관리자만 반영 — 일반 사용자는 무시). */
  hidden: z.enum(["only"]).optional(),
});
export type SharedPostingListQuery = z.infer<typeof SharedPostingListQuerySchema>;

export const SHARED_POSTING_PAGE_SIZE = 30;
