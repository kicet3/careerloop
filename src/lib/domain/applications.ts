/**
 * 지원 추적 계약(클라이언트·서버 공용): 지원 단계·라벨, 입력 zod 스키마, API 응답 형태, 인사이트 출력 형태.
 * 저장은 SQLite applications·application_events(src/lib/db/schema.ts). 제출한 이력서 사본은 저장소
 * users/<userId>/applications/<applicationId>/submitted.json(ResumeDocument)에 고정한다 — 원본 이력서를 지워도 남는다.
 * 날짜(appliedAt·nextDate)는 KST 'YYYY-MM-DD'(src/lib/time/kst.ts).
 */
import { z } from "zod";
import { isValidKstDate } from "@/lib/time/kst";

// ---------------------------------------------------------------------------
// 단계
// ---------------------------------------------------------------------------

export const APPLICATION_STAGES = ["interested", "applied", "assignment", "interview", "offer", "rejected", "withdrawn"] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
export const APPLICATION_STAGE_LABELS: Record<ApplicationStage, string> = {
  interested: "관심",
  applied: "지원 완료",
  assignment: "과제",
  interview: "면접",
  offer: "최종 합격",
  rejected: "불합격",
  withdrawn: "지원 취소",
};

/** 칸반 열 순서(진행 → 종료). */
export const APPLICATION_BOARD_COLUMNS: readonly ApplicationStage[] = APPLICATION_STAGES;

/** 지원서를 낸 뒤의 단계. 응답률 분모 = 이 중 하나에 한 번이라도 도달한 지원(이벤트 기준). */
export const SUBMITTED_STAGES: readonly ApplicationStage[] = ["applied", "assignment", "interview", "offer", "rejected"];
/** 회사가 응답한 단계. 응답률 분자 = 이 중 하나에 한 번이라도 도달한 지원(지금 불합격이어도 센다). */
export const RESPONSE_STAGES: readonly ApplicationStage[] = ["assignment", "interview", "offer"];
/** 끝난 단계(다음 일정 알림 대상 아님). */
export const CLOSED_STAGES: readonly ApplicationStage[] = ["offer", "rejected", "withdrawn"];

// ---------------------------------------------------------------------------
// 입력 스키마(API)
// ---------------------------------------------------------------------------

export const APPLICATION_LIMITS = { company: 150, roleTitle: 250, nextStep: 200, note: 4000, eventNote: 500 } as const;

const text = (max: number) => z.string().trim().max(max);
const id = z.string().trim().min(1).max(64);
/** null 또는 실제 KST 날짜. 빈 문자열은 null로 본다. */
const KstDateOrNull = z
  .union([z.string().trim(), z.null()])
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isValidKstDate(v), "날짜는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.");

const applicationFields = {
  /** 연결할 보관 공고. 있으면 회사·직무를 비워도 공고 값으로 채운다. */
  postingId: id.nullable(),
  company: text(APPLICATION_LIMITS.company),
  roleTitle: text(APPLICATION_LIMITS.roleTitle),
  appliedAt: KstDateOrNull,
  nextStep: text(APPLICATION_LIMITS.nextStep),
  nextDate: KstDateOrNull,
  note: z.string().max(APPLICATION_LIMITS.note),
  favorite: z.boolean(),
  /** 낸 이력서(company_resumes.id)와 그 버전(resume_versions.id). 버전을 주면 그 본문을 제출 사본으로 고정한다. */
  resumeId: id.nullable(),
  resumeVersionId: id.nullable(),
  /** 참고한 진단(diagnoses.id). 회사별 진단 점수와 결과를 나란히 보여 줄 때 쓴다. */
  diagnosisId: id.nullable(),
};

export const ApplicationCreateInputSchema = z
  .object({
    postingId: applicationFields.postingId.default(null),
    company: applicationFields.company.default(""),
    roleTitle: applicationFields.roleTitle.default(""),
    stage: z.enum(APPLICATION_STAGES).default("applied"),
    appliedAt: applicationFields.appliedAt.default(null),
    nextStep: applicationFields.nextStep.default(""),
    nextDate: applicationFields.nextDate.default(null),
    note: applicationFields.note.default(""),
    favorite: applicationFields.favorite.default(false),
    resumeId: applicationFields.resumeId.default(null),
    resumeVersionId: applicationFields.resumeVersionId.default(null),
    diagnosisId: applicationFields.diagnosisId.default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.postingId && (!v.company || !v.roleTitle)) {
      ctx.addIssue({ code: "custom", message: "공고를 고르거나 회사와 직무를 입력하세요.", path: ["company"] });
    }
    if (v.resumeVersionId && !v.resumeId) {
      ctx.addIssue({ code: "custom", message: "이력서 버전을 고르려면 이력서도 골라야 합니다.", path: ["resumeVersionId"] });
    }
  });
export type ApplicationCreateInput = z.output<typeof ApplicationCreateInputSchema>;

/** 지원 수정(PATCH). 단계는 여기서 바꾸지 않는다 — POST /api/applications/[id]/stage(이벤트 기록). */
export const ApplicationUpdateInputSchema = z
  .object(applicationFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "바꿀 항목이 없습니다.");
export type ApplicationUpdateInput = z.output<typeof ApplicationUpdateInputSchema>;

export const ApplicationStageInputSchema = z
  .object({
    stage: z.enum(APPLICATION_STAGES),
    note: text(APPLICATION_LIMITS.eventNote).default(""),
  })
  .strict();
export type ApplicationStageInput = z.output<typeof ApplicationStageInputSchema>;

// ---------------------------------------------------------------------------
// 응답 형태(API·화면)
// ---------------------------------------------------------------------------

export interface JobApplication {
  id: string;
  postingId: string | null;
  company: string;
  roleTitle: string;
  stage: ApplicationStage;
  appliedAt: string | null;
  nextStep: string;
  nextDate: string | null;
  note: string;
  favorite: boolean;
  resumeId: string | null;
  resumeVersionId: string | null;
  /** 지원 시점의 이력서 표시 이름(예: "토스 백엔드 · v3"). 원본 이력서를 지워도 남는다. */
  resumeLabel: string | null;
  /** 제출 사본이 고정돼 있으면 true(GET /api/applications/[id]/submitted). */
  hasSubmittedCopy: boolean;
  diagnosisId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApplicationEvent {
  id: number;
  applicationId: string;
  /** 처음 만들 때는 null. */
  fromStage: ApplicationStage | null;
  toStage: ApplicationStage;
  note: string;
  at: number;
}

export interface ApplicationDetail extends JobApplication {
  events: ApplicationEvent[];
}

// ---------------------------------------------------------------------------
// 인사이트(GET /api/insights) — 실제 결과 집계. 점수와 결과를 나란히 보여도 '합격 확률' 같은 예측 표현은 쓰지 않는다.
// ---------------------------------------------------------------------------

export interface ResponseRate {
  /** 분모: 지원 완료 이후 단계에 한 번이라도 도달한 지원 수. */
  submitted: number;
  /** 분자: 과제·면접·최종 합격 중 하나에 한 번이라도 도달한 지원 수. */
  responded: number;
  /** responded / submitted. 분모가 0이면 null. */
  rate: number | null;
}

export interface StageFunnelRow {
  stage: ApplicationStage;
  /** 이 단계에 한 번이라도 도달한 지원 수(이벤트 기준). */
  reached: number;
  /** 지금 이 단계인 지원 수. */
  current: number;
}

export interface ResumePerformanceRow {
  resumeId: string | null;
  resumeVersionId: string | null;
  label: string;
  submitted: number;
  responded: number;
  rate: number | null;
}

export interface CompanyRollupRow {
  company: string;
  applications: number;
  /** 가장 앞선 단계(진행 순서 기준). */
  bestStage: ApplicationStage;
  /** 연결된 완료 진단의 적합도 점수(fit.matchScore, 0~100). 없으면 null. */
  matchScore: number | null;
}

export type SuggestionKind = "deadline" | "next_step" | "follow_up" | "resume" | "pipeline";
export interface Suggestion {
  kind: SuggestionKind;
  /** 한국어 한 문장. */
  message: string;
  /** 눌러서 갈 앱 내부 경로(선택). */
  href: string | null;
  postingId: string | null;
  applicationId: string | null;
}

export interface InsightsResponse {
  responseRate: ResponseRate;
  funnel: StageFunnelRow[];
  resumePerformance: ResumePerformanceRow[];
  companies: CompanyRollupRow[];
  suggestions: Suggestion[];
}
