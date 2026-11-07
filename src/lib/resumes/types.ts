/**
 * 회사별 이력서 API의 입력 검증 스키마와 응답 타입(클라이언트·서버 공용).
 * 문서 구조·양식은 src/lib/domain/resumes.ts, 저장은 service.ts(메타 PostgreSQL + 본문 저장소).
 */
import { z } from "zod";
import { CreatePortfolioUrlSchema } from "@/lib/domain/portfolios";
import type { PostingStatus } from "@/lib/domain/postings";
import {
  ResumeApplyStatusSchema,
  ResumeKindSchema,
  ResumeTemplateIdSchema,
  StoredResumeDocumentSchema,
  type ResumeApplyStatus,
  type ResumeDocument,
  type ResumeKind,
  type ResumePortfolioInfo,
  type ResumeTemplateId,
  type ResumeVersionSource,
} from "@/lib/domain/resumes";

/** 회사·직무 등 짧은 메타 필드 길이. */
export const MAX_RESUME_META_CHARS = 120;
/** JD 붙여넣기 한도(진단 입력과 같다). */
export const MAX_RESUME_JD_CHARS = 30_000;
export const MAX_RESUME_NOTE_CHARS = 200;
/** 사용자당 이력서 수, 이력서당 버전 수. */
export const MAX_RESUMES_PER_USER = 100;
export const MAX_VERSIONS_PER_RESUME = 200;

/** 초안 출처: 경험 그래프 / 기존 진단의 재작성본 / 빈 문서. */
export const RESUME_DRAFT_SOURCE_KINDS = ["graph", "diagnosis", "blank"] as const;
export type ResumeDraftSourceKind = (typeof RESUME_DRAFT_SOURCE_KINDS)[number];

export const RESUME_DRAFT_SOURCE_LABELS: Record<ResumeDraftSourceKind, { name: string; description: string }> = {
  graph: { name: "경험 그래프에서", description: "정리해 둔 경력·경험 그래프와 JD로 AI가 초안을 씁니다." },
  diagnosis: { name: "기존 진단의 재작성본에서", description: "진단 보고서의 '다시 쓴 이력서'를 이 양식으로 옮깁니다." },
  blank: { name: "빈 문서", description: "AI 없이 빈 양식에서 직접 씁니다." },
};

const metaText = (label: "회사명" | "직무") =>
  z
    .string()
    .trim()
    .min(1, `${label}${label === "회사명" ? "을" : "를"} 입력해 주세요.`)
    .max(MAX_RESUME_META_CHARS, `${label}${label === "회사명" ? "은" : "는"} ${MAX_RESUME_META_CHARS}자 이내로 입력해 주세요.`);

const jdText = z
  .string()
  .max(MAX_RESUME_JD_CHARS, `JD는 ${MAX_RESUME_JD_CHARS.toLocaleString("ko-KR")}자 이내로 붙여넣어 주세요.`);

export const ResumeDraftSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("graph") }),
  z.object({ kind: z.literal("diagnosis"), diagnosisId: z.string().trim().min(1).max(64) }),
  z.object({ kind: z.literal("blank") }),
]);
export type ResumeDraftSource = z.infer<typeof ResumeDraftSourceSchema>;

const optionalMeta = z.string().trim().max(MAX_RESUME_META_CHARS, `${MAX_RESUME_META_CHARS}자 이내로 입력해 주세요.`).optional().default("");

/**
 * POST /api/resumes
 * - kind 'company'(기본): 지원할 공고(postingId)의 회사·직무·JD로 만든다(라우트가 비운 값을 공고로 채운다). 회사·직무는 필수.
 * - kind 'general': 회사 지정 없는 공용 이력서. company·roleTitle·jdText·postingId는 무시한다.
 * - sourceResumeId: 그 이력서(보통 공용 이력서)의 현재 버전 내용으로 시작한다('공용 이력서 내용으로 시작'). 이때 source는 무시한다(AI 없음).
 */
export const CreateResumeInputSchema = z
  .object({
    kind: ResumeKindSchema.optional().default("company"),
    company: optionalMeta,
    roleTitle: optionalMeta,
    jdText: jdText.optional().default(""),
    templateId: ResumeTemplateIdSchema,
    title: z.string().trim().max(MAX_RESUME_META_CHARS).optional().default(""),
    source: ResumeDraftSourceSchema,
    /** AI 초안 엔진(providers). 비우면 기본 엔진. 빈 문서면 무시. */
    provider: z.string().max(40).nullable().optional(),
    /** 보관 공고에서 시작했으면 그 공고 id. 라우트가 소유권을 확인하고, 비운 회사·직무·JD를 공고 값으로 채운다. */
    postingId: z.string().trim().min(1).max(64).nullable().optional(),
    /** 이 이력서의 현재 버전 내용으로 시작한다(서비스가 소유권을 확인). */
    sourceResumeId: z.string().trim().min(1).max(64).nullable().optional(),
    /**
     * 작성 방식(경험 그래프 출처만): 'agent' = JD 요건별 근거·심사위원 심사 루프(src/lib/resume-agent), 'single' = 빠른 초안(LLM 1회).
     * 비우면 에이전트를 쓸 수 있을 때 'agent'. 진단 출처는 항상 'single'.
     */
    mode: z.enum(["agent", "single"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== "company") return;
    if (!v.company) ctx.addIssue({ code: "custom", path: ["company"], message: "지원할 공고를 고르거나 회사명을 입력해 주세요." });
    if (!v.roleTitle) ctx.addIssue({ code: "custom", path: ["roleTitle"], message: "직무를 입력해 주세요." });
  });
export type CreateResumeInput = z.infer<typeof CreateResumeInputSchema>;
/** 화면이 보내는 본문(기본값 채우기 전). */
export type CreateResumeRequest = z.input<typeof CreateResumeInputSchema>;

/** PATCH /api/resumes/[id] — 메타만(본문은 버전 저장). 양식 전환·'사진 넣기'도 여기서 한다. */
export const UpdateResumeMetaSchema = z
  .object({
    company: metaText("회사명"),
    roleTitle: metaText("직무"),
    jdText: jdText.nullable(),
    templateId: ResumeTemplateIdSchema,
    title: z.string().trim().min(1, "제목을 입력해 주세요.").max(MAX_RESUME_META_CHARS),
    /** 머리글에 프로필 사진을 넣을지(사진이 있을 때만 그린다). */
    includePhoto: z.boolean(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), "바꿀 항목이 없습니다.");
export type UpdateResumeMeta = z.infer<typeof UpdateResumeMetaSchema>;

/** POST /api/resumes/[id]/versions */
export const SaveResumeVersionSchema = z.object({
  /** 예전 화면(새 필드가 생기기 전)에서 보낸 문서도 빈 값으로 보정해 받는다. */
  document: StoredResumeDocumentSchema,
  note: z.string().trim().max(MAX_RESUME_NOTE_CHARS).optional(),
  /** 편집을 시작한 버전. 그사이 다른 탭에서 저장했으면 409(덮어쓰기 방지). 생략하면 검사하지 않는다. */
  baseVersionId: z.string().max(64).nullable().optional(),
  /** 편집 화면에서 바꾼 양식. 버전 저장과 함께 이력서의 양식으로 반영한다. 생략하면 그대로. */
  templateId: ResumeTemplateIdSchema.optional(),
});
export type SaveResumeVersion = z.infer<typeof SaveResumeVersionSchema>;

/**
 * PUT /api/resumes/[id]/draft — 임시 저장(새 버전을 만들지 않는 작업본, 이력서당 하나). 본문 검증·크기 한도는 버전 저장과 같다.
 * baseVersionId는 작업을 시작한 버전(현재 버전과 달라도 받는다 — 응답의 currentVersionId로 화면이 충돌을 알린다).
 */
export const SaveResumeEditDraftSchema = z.object({
  document: StoredResumeDocumentSchema,
  baseVersionId: z.string().min(1).max(64).nullable(),
  /** 편집 화면에서 고른 양식(저장 전). 생략·null이면 이력서 양식 그대로. */
  templateId: ResumeTemplateIdSchema.nullable().optional(),
  /**
   * 이 화면이 마지막으로 본·쓴 작업본의 updatedAt(ms, 작업본이 없었으면 null). 서버의 작업본이 그 뒤에 다른 탭·기기에서 바뀌었으면
   * 409(code 'draft_changed')로 거절해 말없이 덮어쓰지 않는다. 작업본이 없어졌으면(다른 곳에서 새 버전 저장·버리기) 새로 만든다.
   * 생략하면 확인하지 않는다(예전 화면 호환).
   */
  expectedUpdatedAt: z.number().int().nonnegative().nullable().optional(),
});
export type SaveResumeEditDraft = z.infer<typeof SaveResumeEditDraftSchema>;

/** 임시 저장본(소유자에게만 보인다). 미리보기 공유·PDF는 저장된 버전만 쓴다. */
export interface ResumeEditDraftView {
  baseVersionId: string | null;
  templateId: ResumeTemplateId | null;
  document: ResumeDocument;
  updatedAt: number;
}

/** PUT /api/resumes/[id]/draft 409: 다른 탭·기기가 그 사이 작업본을 바꿨다(draftUpdatedAt = 서버 작업본의 저장 시각). */
export const RESUME_EDIT_DRAFT_CHANGED = "draft_changed";
export interface ResumeEditDraftClash {
  error: string;
  code: typeof RESUME_EDIT_DRAFT_CHANGED;
  draftUpdatedAt: number;
}

/** GET·PUT /api/resumes/[id]/draft 응답. currentVersionId가 draft.baseVersionId와 다르면 그 사이 새 버전이 저장된 것(충돌). */
export interface ResumeEditDraftResponse {
  draft: ResumeEditDraftView | null;
  currentVersionId: string | null;
}

/**
 * PATCH /api/resumes/[id]/status — 지원 상태 바꾸기(지원처별 이력서만, 공용은 400).
 * - 'submitted'로: 연결 공고가 있으면 공고를 '지원함'으로, 지원 기록을 만들거나(그 공고·이 이력서의 기존 기록이 있으면 잇는다)
 *   현재 버전 본문을 제출 사본으로 고정한다. 연결 공고가 없으면 상태만 바꾼다(지원 기록은 만들지 않는다).
 * - 'submitted'에서 다른 상태로(되돌리기): 화면이 먼저 확인을 받는다. revertPosting이면 공고를 '지원 예정'으로(지금 '지원함'일 때만),
 *   revertApplication이 'withdraw'면 연결된 지원 기록을 '지원 취소' 단계로, 'delete'면 지운다(이 상태 변경이 만든 기록만), 'keep'이면 그대로.
 */
export const ChangeResumeStatusSchema = z.object({
  status: ResumeApplyStatusSchema,
  revertPosting: z.boolean().optional().default(false),
  revertApplication: z.enum(["keep", "withdraw", "delete"]).optional().default("keep"),
});
export type ChangeResumeStatusInput = z.infer<typeof ChangeResumeStatusSchema>;

/**
 * PUT /api/resumes/[id]/portfolio (JSON): { portfolioId }면 보관함의 포트폴리오를 붙이고, { url, title?, description? }면 링크로 보관함에
 * 새 포트폴리오를 만들어 붙인다. 파일은 같은 경로에 multipart(file·title·description)로.
 */
export const ResumePortfolioAttachSchema = z.union([
  z.object({ portfolioId: z.string().trim().min(1, "붙일 포트폴리오를 골라 주세요.").max(64) }).strict(),
  CreatePortfolioUrlSchema.strict(),
]);
export type ResumePortfolioAttachInput = z.infer<typeof ResumePortfolioAttachSchema>;

/** GET /api/resumes?status= 목록 필터. 'general'은 공용 이력서만. */
export const RESUME_LIST_STATUS_FILTERS = ["all", "draft", "applying", "submitted", "general"] as const;
export type ResumeListStatusFilter = (typeof RESUME_LIST_STATUS_FILTERS)[number];

// ---------------------------------------------------------------------------
// 응답
// ---------------------------------------------------------------------------

export interface ResumeMeta {
  id: string;
  /** 'general'이면 company·roleTitle은 ''이고 postingId는 null. */
  kind: ResumeKind;
  company: string;
  roleTitle: string;
  jdText: string | null;
  templateId: ResumeTemplateId;
  title: string;
  currentVersionId: string | null;
  /** 이 이력서를 만든 보관 공고(공고를 지우면 null). */
  postingId: string | null;
  /** 복제·'공용 이력서 내용으로 시작'의 원본 이력서. */
  sourceResumeId: string | null;
  /** 지원 상태. 공용 이력서는 null(화면에는 '공용'). */
  applyStatus: ResumeApplyStatus | null;
  applyStatusChangedAt: number | null;
  /** '지원 완료'로 바꿀 때 만들거나 연결한 지원 기록. */
  submittedApplicationId: string | null;
  /** 첨부한 보관함 포트폴리오(없으면 null). 본문 텍스트는 싣지 않는다(resumes/portfolio.ts getResumePortfolioText). */
  portfolio: ResumePortfolioInfo | null;
  /** 머리글에 프로필 사진을 넣을지(기본 true). 사진은 문서(ResumeDocument)에 넣지 않는다 — AI에 보내지 않고 그릴 때만 붙인다. */
  includePhoto: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 이력서에 연결된 공고 요약(편집기·목록의 '원문 공고 열기'·상태 동기화 표시용). */
export interface ResumePostingLink {
  id: string;
  company: string;
  roleTitle: string;
  /** 원문 주소. 직접 입력 공고면 ""(링크를 그리지 않는다). */
  url: string;
  status: PostingStatus;
  sharedPostingId: string | null;
}

/** PATCH /api/resumes/[id]/status 응답. */
export interface ChangeResumeStatusResult {
  resume: ResumeMeta;
  /** 연결된 지원 기록(만들었거나 이어 붙인 것). 없으면 null. */
  application: { id: string; created: boolean; stage: string } | null;
  /** 바뀐 뒤의 연결 공고 상태(공고가 없으면 null). */
  postingStatus: PostingStatus | null;
}

export interface ResumeListItem extends ResumeMeta {
  versionCount: number;
  currentVersionNo: number | null;
  /** 임시 저장본(새 버전으로 저장하지 않은 작업본)이 있는가. 목록의 '임시 저장본 있음' 배지. */
  hasEditDraft: boolean;
}

export interface ResumeVersionMeta {
  id: string;
  versionNo: number;
  note: string | null;
  source: ResumeVersionSource;
  createdAt: number;
}

export interface ResumeDetail {
  resume: ResumeMeta;
  /** 최신 버전부터. */
  versions: ResumeVersionMeta[];
  current: { versionId: string; versionNo: number; document: ResumeDocument } | null;
  /** 연결 공고(없거나 지워졌으면 null). */
  posting: ResumePostingLink | null;
}

export interface CreateResumeResponse {
  id: string;
  /** AI 초안일 때 판단·가정과 채워야 할 정보(빈 문서면 빈 배열). */
  notes: string[];
  missingInfo: string[];
}
