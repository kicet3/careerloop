/**
 * 채용 공고 보관함 계약(클라이언트·서버 공용): 공고 상태·라벨, 입력 zod 스키마, API 응답 형태,
 * URL 가져오기 작업 상태, 공고 페이지 LLM 추출 출력(PostingExtractSchema). 구역별 구조는 ./posting-structure.ts.
 * 저장은 PostgreSQL job_postings·posting_imports(prisma/schema.prisma). 마감 날짜는 KST 'YYYY-MM-DD'(src/lib/time/kst.ts).
 */
import type { PostingCaptureInfo } from "./posting-capture";
import { z } from "zod";
import { isValidKstDate, isValidKstTime } from "@/lib/time/kst";
import {
  PostingSectionsLlmSchema,
  PostingStructureEditSchema,
  type PostingHighlights,
  type PostingStructure,
} from "./posting-structure";

// ---------------------------------------------------------------------------
// 상태·분류
// ---------------------------------------------------------------------------

export const POSTING_STATUSES = ["saved", "reviewing", "planned", "applied", "on_hold", "closed"] as const;
export type PostingStatus = (typeof POSTING_STATUSES)[number];
export const POSTING_STATUS_LABELS: Record<PostingStatus, string> = {
  saved: "관심",
  reviewing: "검토 중",
  planned: "지원 예정",
  applied: "지원함",
  on_hold: "보류",
  closed: "마감",
};

/** date: 마감일 있음 · rolling: 상시/채용 시 마감 · unspecified: 마감일 미공개. */
export const DEADLINE_KINDS = ["date", "rolling", "unspecified"] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];
export const DEADLINE_KIND_LABELS: Record<DeadlineKind, string> = {
  date: "마감일",
  rolling: "상시 채용",
  unspecified: "마감일 미공개",
};

export const EMPLOYMENT_TYPES = ["full_time", "contract", "intern", "new_grad", "freelance", "other", "unknown"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "정규직",
  contract: "계약직",
  intern: "인턴",
  new_grad: "신입 공채",
  freelance: "프리랜서",
  other: "기타",
  unknown: "미확인",
};

export const WORK_TYPES = ["onsite", "hybrid", "remote", "unknown"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  onsite: "출근",
  hybrid: "하이브리드",
  remote: "원격",
  unknown: "미확인",
};

export const CAREER_LEVELS = ["entry", "experienced", "senior", "manager", "any", "unknown"] as const;
export type CareerLevel = (typeof CAREER_LEVELS)[number];
export const CAREER_LEVEL_LABELS: Record<CareerLevel, string> = {
  entry: "신입 가능",
  experienced: "경력",
  senior: "시니어",
  manager: "관리자",
  any: "경력 무관",
  unknown: "미명시",
};

// ---------------------------------------------------------------------------
// 길이 상한
// ---------------------------------------------------------------------------

export const POSTING_LIMITS = {
  company: 150,
  roleTitle: 250,
  url: 2048,
  jdText: 30_000,
  location: 300,
  note: 6000,
  platform: 40,
} as const;

/** 사용자별 하루 URL 가져오기 횟수(KST 자정 기준이 아니라 최근 24시간). */
export const DAILY_POSTING_IMPORT_LIMIT = 20;

// ---------------------------------------------------------------------------
// 입력 스키마(API)
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
/** 빈 문자열이면 날짜 없음. */
const DeadlineDateSchema = z
  .string()
  .trim()
  .refine((v) => v === "" || isValidKstDate(v), "마감일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");
const DeadlineTimeSchema = z
  .string()
  .trim()
  .refine((v) => v === "" || isValidKstTime(v), "마감 시각은 HH:mm(한국 시간) 형식이어야 합니다.");

const postingFields = {
  company: text(POSTING_LIMITS.company).min(1, "회사 이름을 입력하세요."),
  roleTitle: text(POSTING_LIMITS.roleTitle).min(1, "직무를 입력하세요."),
  /** 빈 문자열이면 URL 없음. 형식 검사·정규화(url_key)는 서비스가 src/lib/postings/url.ts로 한다. */
  url: text(POSTING_LIMITS.url),
  status: z.enum(POSTING_STATUSES),
  jdText: z.string().max(POSTING_LIMITS.jdText, "JD는 30,000자 이내로 입력하세요."),
  deadline: DeadlineDateSchema,
  deadlineTime: DeadlineTimeSchema,
  deadlineKind: z.enum(DEADLINE_KINDS),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  workType: z.enum(WORK_TYPES),
  location: text(POSTING_LIMITS.location),
  careerLevel: z.enum(CAREER_LEVELS),
  note: z.string().max(POSTING_LIMITS.note),
};

/** 마감 세 필드의 일관성. 문제가 있으면 한국어 오류, 없으면 null. PATCH는 기존 행과 합친 값으로 다시 부른다. */
export function postingDeadlineError(v: { deadline: string; deadlineTime: string; deadlineKind: DeadlineKind }): string | null {
  if (v.deadlineTime && !v.deadline) return "마감 시각만 넣을 수는 없습니다. 마감일을 함께 입력하세요.";
  if (v.deadline && v.deadlineKind !== "date") return "마감일이 있으면 마감 종류는 '마감일'이어야 합니다.";
  if (!v.deadline && v.deadlineKind === "date") return "마감 종류가 '마감일'이면 마감일을 입력하세요.";
  return null;
}

/** 공고 직접 추가. 생략한 필드는 기본값(상태 saved, 마감 종류는 마감일이 있으면 date, 없으면 unspecified). */
export const PostingCreateInputSchema = z
  .object({
    company: postingFields.company,
    roleTitle: postingFields.roleTitle,
    url: postingFields.url.default(""),
    status: postingFields.status.default("saved"),
    jdText: postingFields.jdText.default(""),
    deadline: postingFields.deadline.default(""),
    deadlineTime: postingFields.deadlineTime.default(""),
    deadlineKind: postingFields.deadlineKind.optional(),
    employmentType: postingFields.employmentType.default("unknown"),
    workType: postingFields.workType.default("unknown"),
    location: postingFields.location.default(""),
    careerLevel: postingFields.careerLevel.default("unknown"),
    note: postingFields.note.default(""),
  })
  .strict()
  .transform((v) => ({ ...v, deadlineKind: v.deadlineKind ?? (v.deadline ? ("date" as const) : ("unspecified" as const)) }))
  .superRefine((v, ctx) => {
    const err = postingDeadlineError(v);
    if (err) ctx.addIssue({ code: "custom", message: err, path: ["deadline"] });
  });
export type PostingCreateInput = z.output<typeof PostingCreateInputSchema>;

/**
 * 공고 수정(PATCH). 보낸 필드만 바꾼다. 마감 일관성은 서비스가 기존 행과 합쳐 postingDeadlineError로 검사한다.
 * structured: '구역 편집' 결과(출처는 'user'로 저장).
 */
export const PostingUpdateInputSchema = z
  .object({ ...postingFields, structured: PostingStructureEditSchema })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "바꿀 항목이 없습니다.");
export type PostingUpdateInput = z.output<typeof PostingUpdateInputSchema>;

/** URL 가져오기 요청. 형식·공개 주소 검사는 src/lib/postings/url.ts parsePostingUrl. */
export const PostingImportInputSchema = z
  .object({
    url: z.string().trim().min(1, "공고 주소를 입력하세요.").max(POSTING_LIMITS.url),
    /** '다시 가져오기': 공고 찾기에 같은 공고가 있어도 페이지를 다시 읽고, 내 보관함의 같은 공고를 새 내용으로 맞춘다. */
    refresh: z.boolean().optional().default(false),
  })
  .strict();

// ---------------------------------------------------------------------------
// 응답 형태(API·화면)
// ---------------------------------------------------------------------------

/** 공고 하나(API 응답). 시각은 ms, 빈 텍스트 필드는 ""(날짜 없음도 ""). */
export interface JobPosting {
  id: string;
  company: string;
  roleTitle: string;
  url: string;
  /** 중복 판별용 정규화 URL(normalizeUrl). URL이 없으면 null. */
  urlKey: string | null;
  /** 채용 플랫폼 식별자(예: wanted, jobkorea, saramin) 또는 호스트 이름. 모르면 "". */
  platform: string;
  status: PostingStatus;
  /** 진단·이력서·경력 대조가 읽는 JD 텍스트. URL 가져오기는 구조를 제목 붙은 구역 텍스트로 조합한 값(원문은 sourceText). */
  jdText: string;
  /**
   * 구역별 구조. 저장된 값이 없으면 getPosting이 jdText를 정규식으로 즉석 구조화한 값(source 'regex', 저장하지 않음)을 싣는다.
   * 목록(JobPostingSummary)에는 없다.
   */
  structured: PostingStructure | null;
  /** 가져온 페이지 본문 원문. 직접 입력은 ""(jdText가 원문). */
  sourceText: string;
  deadline: string;
  deadlineTime: string;
  deadlineKind: DeadlineKind;
  employmentType: EmploymentType;
  workType: WorkType;
  location: string;
  careerLevel: CareerLevel;
  note: string;
  /** 'manual' 또는 AI 추출 엔진(ProviderId, 예: 'claude-cli'). */
  extractedBy: string;
  /** URL 가져오기(또는 공고 찾기에서 담기)로 만든 공고면 공용 공고 id. 직접 입력은 null. */
  sharedPostingId: string | null;
  /** 공용 공고의 원문 페이지 캡처 상태(상세 조회에만 실린다 — 이미지는 GET /api/postings/[id]/capture). */
  capture?: PostingCaptureInfo;
  createdAt: number;
  updatedAt: number;
}

/** 목록 화면용 요약(JD·구조·원문 제외). highlights는 카드 칩(기술 스택·연봉)용으로 서버가 구조에서 잘라 낸 값. */
export type JobPostingSummary = Omit<JobPosting, "jdText" | "structured" | "sourceText"> & { hasJd: boolean; highlights?: PostingHighlights };

// ---------------------------------------------------------------------------
// URL 가져오기 작업
// ---------------------------------------------------------------------------

export const POSTING_IMPORT_STATUSES = ["queued", "reading", "analyzing", "completed", "failed"] as const;
export type PostingImportStatus = (typeof POSTING_IMPORT_STATUSES)[number];
export const POSTING_IMPORT_STATUS_LABELS: Record<PostingImportStatus, string> = {
  queued: "대기 중",
  reading: "공고 읽는 중",
  analyzing: "AI 분석 중",
  completed: "추가 완료",
  failed: "추가 실패",
};
export const isPostingImportActive = (s: PostingImportStatus) => s === "queued" || s === "reading" || s === "analyzing";

export interface PostingImportJob {
  id: string;
  url: string;
  status: PostingImportStatus;
  /** 사용자에게 보여도 되는 한국어 오류 문구(내부 오류 원문은 담지 않는다). */
  error: string | null;
  postingId: string | null;
  /** 결과 공용 공고 id(재사용했거나 새로 만든 것). */
  sharedPostingId: string | null;
  /** '다시 가져오기' 작업이면 true. */
  refresh: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// LLM 추출 출력(task 'posting-extract')
// ---------------------------------------------------------------------------

/**
 * 공고 페이지 본문에서 뽑은 사실(회사·직무·마감 등). 공고 내용은 PostingExtractSchema의 sections(구역별 항목)로 받는다. 구조화 출력용이라 선택 필드·유니온 없이 모든 필드 필수(없으면 "" / 'unknown').
 * *Evidence는 페이지 본문 원문 그대로의 짧은 인용 — extract.ts가 본문에 실제로 있는지 확인하고, 근거 없는 값은 버린다.
 */
export const PostingFactsSchema = z.object({
  isJobPosting: z.boolean().describe("단일 모집 공고 상세면 true. 목록·로그인·차단·삭제 안내 페이지면 false"),
  company: z.string().max(200).describe("회사 이름. 본문에 없으면 빈 문자열"),
  companyEvidence: z.string().max(500).describe("회사 이름이 나온 본문 문구를 그대로 짧게 복사"),
  roleTitle: z.string().max(300).describe("모집 직무. 본문에 없으면 빈 문자열"),
  roleEvidence: z.string().max(500).describe("모집 직무가 나온 본문 문구를 그대로 짧게 복사"),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  workType: z.enum(WORK_TYPES),
  location: z.string().max(300).describe("근무지. 근거 없으면 빈 문자열"),
  careerLevel: z.enum(CAREER_LEVELS),
  deadline: z.string().max(40).describe("접수 마감일 YYYY-MM-DD(한국 날짜). 연도나 날짜가 불명확하면 빈 문자열"),
  deadlineTime: z.string().max(10).describe("명시된 마감 시각을 한국 시간 HH:mm으로. 날짜만 있으면 빈 문자열"),
  deadlineEvidence: z.string().max(500).describe("마감일·시각이 나온 본문 문구를 그대로 복사. 없으면 빈 문자열"),
  rolling: z.boolean().describe("'상시 채용'·'채용 시 마감'이 명시된 경우만 true"),
});
export type PostingFacts = z.infer<typeof PostingFactsSchema>;

/** URL 가져오기의 LLM 출력: 사실 + 구역별 항목(호출 1회). */
export const PostingExtractSchema = PostingFactsSchema.extend({ sections: PostingSectionsLlmSchema });
export type PostingExtract = z.infer<typeof PostingExtractSchema>;
