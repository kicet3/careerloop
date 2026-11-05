import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ApplicationStage } from "@/lib/domain/applications";
import type { ChatMessageData, ChatMessageStatus, ChatRole, ChatThreadKind } from "@/lib/domain/chat";
import type {
  CareerLevel,
  DeadlineKind,
  EmploymentType,
  PostingImportStatus,
  PostingStatus,
  WorkType,
} from "@/lib/domain/postings";
import type { ProviderId } from "@/lib/domain/providers";
import type { ResumeTemplateId, ResumeVersionSource } from "@/lib/domain/resumes";
import type { DiagnosisStatus, ReviewerId, Situation, StageKey, StageStatus } from "@/lib/domain/schemas";

const now = sql`(unixepoch() * 1000)`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  /** 예전 이메일·비밀번호 가입 계정의 해시(비밀번호 로그인은 없어졌다). Google 계정은 null. */
  passwordHash: text("password_hash"),
  /** Google 계정 고유 ID(id_token의 sub). Google 로그인을 연결하지 않았으면 null. */
  googleSub: text("google_sub").unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
});

/** 세션 토큰 원문은 쿠키에만 있고, DB에는 SHA-256 해시를 id로 저장한다. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * 채용 공고 보관함. 직접 입력하거나 URL 가져오기(posting_imports)로 만든다. 같은 사용자 안에서 정규화 URL(url_key)은
 * 유일하다(URL 없는 공고는 url_key null이라 여러 개 가능). 마감은 KST 날짜·시각 문자열(domain/postings.ts).
 */
export const jobPostings = sqliteTable(
  "job_postings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    roleTitle: text("role_title").notNull(),
    url: text("url"),
    /** normalizeUrl(url). 중복 판별용. */
    urlKey: text("url_key"),
    platform: text("platform"),
    status: text("status").$type<PostingStatus>().notNull().default("saved"),
    /** JD 원문(≤30000자). URL 가져오기면 페이지 본문. */
    jdText: text("jd_text"),
    /** 'YYYY-MM-DD'(KST). */
    deadline: text("deadline"),
    /** 'HH:mm'(KST). 날짜만 있으면 null. */
    deadlineTime: text("deadline_time"),
    deadlineKind: text("deadline_kind").$type<DeadlineKind>().notNull().default("unspecified"),
    employmentType: text("employment_type").$type<EmploymentType>().notNull().default("unknown"),
    workType: text("work_type").$type<WorkType>().notNull().default("unknown"),
    location: text("location"),
    careerLevel: text("career_level").$type<CareerLevel>().notNull().default("unknown"),
    note: text("note"),
    /** 'manual' 또는 AI 추출 엔진(ProviderId). */
    extractedBy: text("extracted_by").notNull().default("manual"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    index("job_postings_user_idx").on(t.userId, t.updatedAt),
    uniqueIndex("job_postings_url_uq").on(t.userId, t.urlKey),
  ],
);

/**
 * 공고 URL 가져오기 작업. after()로 백그라운드 실행하고 화면은 폴링한다. 실행은 조건부 UPDATE(status·updatedAt)로
 * 한 번만 차지하고, queued/reading/analyzing인 채로 오래 멈춘 작업은 조회 시 다시 실행한다(attempts로 횟수 제한).
 * 하루 가져오기 제한은 이 표의 최근 24시간 행 수로 센다.
 */
export const postingImports = sqliteTable(
  "posting_imports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    status: text("status").$type<PostingImportStatus>().notNull().default("queued"),
    /** 사용자에게 보여도 되는 한국어 오류 문구. */
    error: text("error"),
    postingId: text("posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("posting_imports_user_idx").on(t.userId, t.createdAt)],
);

export const diagnoses = sqliteTable(
  "diagnoses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    targetRole: text("target_role").notNull(),
    situation: text("situation").$type<Situation>().notNull(),
    notes: text("notes"),
    jdText: text("jd_text"),
    resumeText: text("resume_text").notNull(),
    resumeFileName: text("resume_file_name"),
    /** 포트폴리오 본문(파일에서 뽑은 텍스트 + 텍스트/URL 메모). 없으면 null. */
    portfolioText: text("portfolio_text"),
    /** 포트폴리오 원본 파일 이름(파일로 냈을 때만). */
    portfolioFileName: text("portfolio_file_name"),
    /** 이 진단에 쓴 보관 공고. 공고를 지우면 null(진단의 JD 사본은 jdText에 남는다). */
    postingId: text("posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    status: text("status").$type<DiagnosisStatus>().notNull().default("queued"),
    error: text("error"),
    /** 공개 공유 링크 토큰. null이면 비공개. */
    shareToken: text("share_token").unique(),
    model: text("model").notNull(),
    /** 진단을 돌리는 AI 엔진(domain/providers.ts). 재시도도 같은 엔진으로 한다. 예전 행은 null(model로 추정). */
    provider: text("provider").$type<ProviderId>(),
    /**
     * 현재 실행(run)의 식별자. runDiagnosis가 진단을 차지할 때 새로 정하고, 실행 중 모든 쓰기를 이 값으로 조건 건다.
     * 멈춘 실행으로 판정된 뒤 재시도가 새 실행을 시작하면, 예전 실행의 늦은 쓰기는 아무 행에도 닿지 않는다.
     */
    runId: text("run_id"),
    /** 누적 토큰 사용량 JSON: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } */
    usage: text("usage", { mode: "json" }).$type<UsageTotals>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("diagnoses_user_idx").on(t.userId, t.createdAt), index("diagnoses_posting_idx").on(t.postingId)],
);

export const diagnosisStages = sqliteTable(
  "diagnosis_stages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    diagnosisId: text("diagnosis_id")
      .notNull()
      .references(() => diagnoses.id, { onDelete: "cascade" }),
    stage: text("stage").$type<StageKey>().notNull(),
    status: text("status").$type<StageStatus>().notNull().default("pending"),
    /** STAGE_SCHEMAS[stage]를 통과한 JSON. */
    output: text("output", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("diagnosis_stage_uq").on(t.diagnosisId, t.stage)],
);

/**
 * 진단 실행 원장(append-only). 진단을 만들거나 재시도할 때마다 한 줄을 쓰고 지우지 않는다.
 * 하루 제한·재시도 횟수는 이 표로 센다 — 진단을 삭제해도 줄어들지 않는다(diagnosisId에 FK를 걸지 않는 이유).
 */
export const diagnosisRuns = sqliteTable(
  "diagnosis_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    diagnosisId: text("diagnosis_id").notNull(),
    /** create: 새 진단, retry: 사용자 재시도, continue: 시간 예산에 걸린 뒤 자동 이어하기(재시도 횟수와 따로 센다). */
    kind: text("kind").$type<"create" | "retry" | "continue">().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("diagnosis_runs_user_idx").on(t.userId, t.createdAt), index("diagnosis_runs_diag_idx").on(t.diagnosisId)],
);

/**
 * 채팅 스레드. kind='graph'는 경력 그래프 채팅(진단과 무관), kind='reviewer'는 완료된 진단의 심사위원 한 명과의 대화
 * (diagnosisId·reviewer 필수). 진단을 지우면 그 진단의 심사위원 채팅도 함께 지운다.
 */
export const chatThreads = sqliteTable(
  "chat_threads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ChatThreadKind>().notNull(),
    diagnosisId: text("diagnosis_id").references(() => diagnoses.id, { onDelete: "cascade" }),
    reviewer: text("reviewer").$type<ReviewerId>(),
    title: text("title").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    index("chat_threads_user_idx").on(t.userId, t.kind, t.updatedAt),
    index("chat_threads_diag_idx").on(t.diagnosisId, t.reviewer),
  ],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").$type<ChatRole>().notNull(),
    content: text("content").notNull(),
    /** 구조화 부가 정보(그래프 변경안, 수정 제안 등) — domain/chat.ts ChatMessageDataSchema. */
    data: text("data", { mode: "json" }).$type<ChatMessageData>(),
    /** 변경안 처리 상태 등(proposed/applied/dismissed/failed). 일반 메시지는 null. */
    status: text("status").$type<ChatMessageStatus>(),
    usage: text("usage", { mode: "json" }).$type<UsageTotals>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("chat_messages_thread_idx").on(t.threadId, t.createdAt)],
);

/** 회사(지원처)별 이력서. 본문은 버전별로 오브젝트 저장소(R2/로컬)에 JSON으로 두고 여기에는 메타데이터만 둔다. */
export const companyResumes = sqliteTable(
  "company_resumes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    roleTitle: text("role_title").notNull(),
    jdText: text("jd_text"),
    /** 이 이력서를 만든 보관 공고. 공고를 지우면 null. */
    postingId: text("posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    templateId: text("template_id").$type<ResumeTemplateId>().notNull(),
    title: text("title").notNull(),
    /** 현재 버전(resume_versions.id). 버전이 아직 없으면 null. FK는 순환을 피하려고 걸지 않는다. */
    currentVersionId: text("current_version_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("company_resumes_user_idx").on(t.userId, t.updatedAt), index("company_resumes_posting_idx").on(t.postingId)],
);

export const resumeVersions = sqliteTable(
  "resume_versions",
  {
    id: text("id").primaryKey(),
    resumeId: text("resume_id")
      .notNull()
      .references(() => companyResumes.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    /** 저장소 키(users/<userId>/resumes/<resumeId>/...). 본문은 ResumeDocument JSON. */
    storageKey: text("storage_key").notNull(),
    note: text("note"),
    source: text("source").$type<ResumeVersionSource>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [uniqueIndex("resume_versions_no_uq").on(t.resumeId, t.versionNo)],
);

/**
 * 지원 기록. 공고·이력서·진단과 느슨하게 연결한다(원본을 지우면 FK는 null, 기록은 남는다).
 * 제출 사본(submittedKey)은 저장소의 ResumeDocument JSON — 지원 완료로 바꾸거나 이력서 버전을 지정할 때 그 버전을 복사해 고정한다.
 * resumeVersionId에는 FK를 걸지 않는다: 이력서를 지워도 버전별 성과 집계가 유지되게.
 */
export const applications = sqliteTable(
  "applications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postingId: text("posting_id").references(() => jobPostings.id, { onDelete: "set null" }),
    company: text("company").notNull(),
    roleTitle: text("role_title").notNull(),
    stage: text("stage").$type<ApplicationStage>().notNull().default("applied"),
    /** 'YYYY-MM-DD'(KST). */
    appliedAt: text("applied_at"),
    nextStep: text("next_step"),
    /** 'YYYY-MM-DD'(KST). */
    nextDate: text("next_date"),
    note: text("note"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    resumeId: text("resume_id").references(() => companyResumes.id, { onDelete: "set null" }),
    resumeVersionId: text("resume_version_id"),
    /** 지원 시점의 이력서 표시 이름(예: "토스 백엔드 · v3"). */
    resumeLabel: text("resume_label"),
    /** 제출 사본 저장소 키(users/<u>/applications/<id>/submitted.json). 없으면 null. */
    submittedKey: text("submitted_key"),
    diagnosisId: text("diagnosis_id").references(() => diagnoses.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [
    index("applications_user_idx").on(t.userId, t.updatedAt),
    index("applications_posting_idx").on(t.postingId),
  ],
);

/** 지원 단계 변경 이력(append-only). 단계를 바꾸는 같은 트랜잭션에서 쓴다. 응답률·단계 도달은 이 표로 센다. */
export const applicationEvents = sqliteTable(
  "application_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /** 처음 만들 때는 null. */
    fromStage: text("from_stage").$type<ApplicationStage>(),
    toStage: text("to_stage").$type<ApplicationStage>().notNull(),
    note: text("note"),
    at: integer("at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("application_events_app_idx").on(t.applicationId, t.at)],
);

/**
 * 비용이 드는 기능의 요청 제한 원장(인스턴스 사이에 공유되는 레이트 리밋). bucket별로 key(사용자 ID 또는 IP 해시)의
 * 창 안 기록 수를 센다(src/lib/auth/db-rate-limit.ts). 창이 지난 행은 기록할 때 지운다.
 */
export const rateEvents = sqliteTable(
  "rate_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("rate_events_key_idx").on(t.bucket, t.key, t.createdAt)],
);

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type User = typeof users.$inferSelect;
export type Diagnosis = typeof diagnoses.$inferSelect;
export type DiagnosisStage = typeof diagnosisStages.$inferSelect;
export type ChatThreadRow = typeof chatThreads.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type CompanyResume = typeof companyResumes.$inferSelect;
export type ResumeVersion = typeof resumeVersions.$inferSelect;
export type JobPostingRow = typeof jobPostings.$inferSelect;
export type PostingImportRow = typeof postingImports.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export type ApplicationEventRow = typeof applicationEvents.$inferSelect;
