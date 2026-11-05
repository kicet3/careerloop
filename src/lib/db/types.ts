/**
 * DB 행 타입. Prisma 모델 타입(src/generated/prisma)은 상태·종류 컬럼이 string, JSON 컬럼이 JsonValue라서
 * 도메인 유니온(src/lib/domain/*)과 JSON 모양으로 좁혀 둔다. 서비스는 Prisma 결과를 이 타입으로 돌려준다
 * (값의 허용 범위는 쓰기 경계의 zod 검증이 보장한다).
 */
import type * as P from "@/generated/prisma/client";
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

/** 누적 토큰 사용량(diagnoses.usage, chat_messages.usage JSON). */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

type Narrow<T, N extends { [K in keyof T]?: unknown }> = Omit<T, keyof N> & N;

export type User = P.User;
export type Session = P.Session;
export type RateEventRow = P.RateEvent;

export type JobPostingRow = Narrow<
  P.JobPosting,
  {
    status: PostingStatus;
    deadlineKind: DeadlineKind;
    employmentType: EmploymentType;
    workType: WorkType;
    careerLevel: CareerLevel;
  }
>;

export type PostingImportRow = Narrow<P.PostingImport, { status: PostingImportStatus }>;

export type Diagnosis = Narrow<
  P.Diagnosis,
  { situation: Situation; status: DiagnosisStatus; provider: ProviderId | null; usage: UsageTotals | null }
>;

export type DiagnosisStage = Narrow<P.DiagnosisStage, { stage: StageKey; status: StageStatus; output: unknown }>;

export type DiagnosisRunRow = Narrow<P.DiagnosisRun, { kind: "create" | "retry" | "continue" }>;

export type ChatThreadRow = Narrow<P.ChatThread, { kind: ChatThreadKind; reviewer: ReviewerId | null }>;

export type ChatMessageRow = Narrow<
  P.ChatMessage,
  { role: ChatRole; data: ChatMessageData | null; status: ChatMessageStatus | null; usage: UsageTotals | null }
>;

export type CompanyResume = Narrow<P.CompanyResume, { templateId: ResumeTemplateId }>;

export type ResumeVersion = Narrow<P.ResumeVersion, { source: ResumeVersionSource }>;

export type ApplicationRow = Narrow<P.Application, { stage: ApplicationStage }>;

export type ApplicationEventRow = Narrow<P.ApplicationEvent, { fromStage: ApplicationStage | null; toStage: ApplicationStage }>;
