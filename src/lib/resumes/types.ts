/**
 * 회사별 이력서 API의 입력 검증 스키마와 응답 타입(클라이언트·서버 공용).
 * 문서 구조·양식은 src/lib/domain/resumes.ts, 저장은 service.ts(메타 PostgreSQL + 본문 저장소).
 */
import { z } from "zod";
import {
  ResumeTemplateIdSchema,
  StoredResumeDocumentSchema,
  type ResumeDocument,
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

/** 초안 출처: 경력 그래프 / 기존 진단의 재작성본 / 빈 문서. */
export const RESUME_DRAFT_SOURCE_KINDS = ["graph", "diagnosis", "blank"] as const;
export type ResumeDraftSourceKind = (typeof RESUME_DRAFT_SOURCE_KINDS)[number];

export const RESUME_DRAFT_SOURCE_LABELS: Record<ResumeDraftSourceKind, { name: string; description: string }> = {
  graph: { name: "경력 그래프에서", description: "정리해 둔 경력·경험 그래프와 JD로 AI가 초안을 씁니다." },
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

/** POST /api/resumes */
export const CreateResumeInputSchema = z.object({
  company: metaText("회사명"),
  roleTitle: metaText("직무"),
  jdText: jdText.optional().default(""),
  templateId: ResumeTemplateIdSchema,
  title: z.string().trim().max(MAX_RESUME_META_CHARS).optional().default(""),
  source: ResumeDraftSourceSchema,
  /** AI 초안 엔진(providers). 비우면 기본 엔진. 빈 문서면 무시. */
  provider: z.string().max(40).nullable().optional(),
  /** 보관 공고에서 시작했으면 그 공고 id. 라우트가 소유권을 확인하고, 비운 회사·직무·JD를 공고 값으로 채운다. */
  postingId: z.string().trim().min(1).max(64).nullable().optional(),
});
export type CreateResumeInput = z.infer<typeof CreateResumeInputSchema>;

/** PATCH /api/resumes/[id] — 메타만(본문은 버전 저장). 양식 전환도 여기서 한다. */
export const UpdateResumeMetaSchema = z
  .object({
    company: metaText("회사명"),
    roleTitle: metaText("직무"),
    jdText: jdText.nullable(),
    templateId: ResumeTemplateIdSchema,
    title: z.string().trim().min(1, "제목을 입력해 주세요.").max(MAX_RESUME_META_CHARS),
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
});
export type SaveResumeVersion = z.infer<typeof SaveResumeVersionSchema>;

// ---------------------------------------------------------------------------
// 응답
// ---------------------------------------------------------------------------

export interface ResumeMeta {
  id: string;
  company: string;
  roleTitle: string;
  jdText: string | null;
  templateId: ResumeTemplateId;
  title: string;
  currentVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResumeListItem extends ResumeMeta {
  versionCount: number;
  currentVersionNo: number | null;
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
}

export interface CreateResumeResponse {
  id: string;
  /** AI 초안일 때 판단·가정과 채워야 할 정보(빈 문서면 빈 배열). */
  notes: string[];
  missingInfo: string[];
}
