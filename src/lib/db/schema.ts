import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { DiagnosisStatus, Situation, StageKey, StageStatus } from "@/lib/domain/schemas";

const now = sql`(unixepoch() * 1000)`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash").notNull(),
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
    status: text("status").$type<DiagnosisStatus>().notNull().default("queued"),
    error: text("error"),
    /** 공개 공유 링크 토큰. null이면 비공개. */
    shareToken: text("share_token").unique(),
    model: text("model").notNull(),
    /** 누적 토큰 사용량 JSON: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } */
    usage: text("usage", { mode: "json" }).$type<UsageTotals>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("diagnoses_user_idx").on(t.userId, t.createdAt)],
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

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type User = typeof users.$inferSelect;
export type Diagnosis = typeof diagnoses.$inferSelect;
export type DiagnosisStage = typeof diagnosisStages.$inferSelect;
