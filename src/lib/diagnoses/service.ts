import "server-only";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { diagnoses, diagnosisStages, type Diagnosis, type DiagnosisStage } from "@/lib/db/schema";
import { REVIEWER_IDS, STAGE_KEYS, type DiagnosisInput, type StageKey } from "@/lib/domain/schemas";
import { currentModelName } from "@/lib/llm";
import {
  dailyDiagnosisLimit,
  diagnosisTitle,
  matchScoreOf,
  positiveCountOf,
  STALE_AFTER_MS,
} from "./summary";
import type { DiagnosisListItem } from "./types";
import { DiagnosisServiceError } from "./errors";

export { DiagnosisServiceError };

export type { DiagnosisListItem, DiagnosisStatusResponse } from "./types";

const STALE_MESSAGE = "진단이 10분 넘게 진행되지 않아 중단되었습니다. 다시 시도해 주세요.";
const STAGE_ORDER = new Map<StageKey, number>(STAGE_KEYS.map((k, i) => [k, i]));

function sortStages(stages: DiagnosisStage[]): DiagnosisStage[] {
  return stages.sort((a, b) => (STAGE_ORDER.get(a.stage) ?? 99) - (STAGE_ORDER.get(b.stage) ?? 99));
}

async function loadStages(diagnosisId: string): Promise<DiagnosisStage[]> {
  const rows = await db.select().from(diagnosisStages).where(eq(diagnosisStages.diagnosisId, diagnosisId));
  return sortStages(rows);
}

export async function getDiagnosisForUser(
  id: string,
  userId: string,
): Promise<{ diagnosis: Diagnosis; stages: DiagnosisStage[] } | null> {
  const [diagnosis] = await db
    .select()
    .from(diagnoses)
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)))
    .limit(1);
  if (!diagnosis) return null;
  return { diagnosis, stages: await loadStages(id) };
}

export async function getDiagnosisByShareToken(
  token: string,
): Promise<{ diagnosis: Diagnosis; stages: DiagnosisStage[] } | null> {
  if (!token || token.length < 16) return null;
  const [diagnosis] = await db.select().from(diagnoses).where(eq(diagnoses.shareToken, token)).limit(1);
  if (!diagnosis) return null;
  return { diagnosis, stages: await loadStages(diagnosis.id) };
}

export async function listDiagnoses(userId: string): Promise<DiagnosisListItem[]> {
  const rows = await db
    .select({
      id: diagnoses.id,
      title: diagnoses.title,
      targetRole: diagnoses.targetRole,
      status: diagnoses.status,
      createdAt: diagnoses.createdAt,
      jdText: diagnoses.jdText,
    })
    .from(diagnoses)
    .where(eq(diagnoses.userId, userId))
    .orderBy(desc(diagnoses.createdAt))
    .limit(200);
  if (rows.length === 0) return [];

  const summaryStages: StageKey[] = [...REVIEWER_IDS, "fit"];
  const stageRows = await db
    .select({
      diagnosisId: diagnosisStages.diagnosisId,
      stage: diagnosisStages.stage,
      status: diagnosisStages.status,
      output: diagnosisStages.output,
    })
    .from(diagnosisStages)
    .where(
      and(
        inArray(
          diagnosisStages.diagnosisId,
          rows.map((r) => r.id),
        ),
        inArray(diagnosisStages.stage, summaryStages),
        eq(diagnosisStages.status, "done"),
      ),
    );
  const byDiagnosis = new Map<string, typeof stageRows>();
  for (const s of stageRows) {
    const list = byDiagnosis.get(s.diagnosisId) ?? [];
    list.push(s);
    byDiagnosis.set(s.diagnosisId, list);
  }

  return rows.map((r) => {
    const stages = byDiagnosis.get(r.id) ?? [];
    return {
      id: r.id,
      title: r.title,
      targetRole: r.targetRole,
      status: r.status,
      positiveCount: positiveCountOf(stages),
      matchScore: matchScoreOf(stages),
      createdAt: r.createdAt,
      hasJd: !!r.jdText,
    };
  });
}

/**
 * 진단 행 + 13개 단계 행(pending)을 만든다. 실행(runDiagnosis)은 호출자가 after()로 예약한다.
 * 제한: 사용자당 진행 중(queued/running) 1건(409), 최근 24시간 DAILY_DIAGNOSIS_LIMIT건(429).
 */
export async function createDiagnosis(userId: string, input: DiagnosisInput): Promise<{ id: string }> {
  await markStaleRunsFailed(userId);
  const id = nanoid();
  const now = new Date();
  const limit = dailyDiagnosisLimit();

  await db.transaction(async (tx) => {
    const [active] = await tx
      .select({ id: diagnoses.id })
      .from(diagnoses)
      .where(and(eq(diagnoses.userId, userId), inArray(diagnoses.status, ["queued", "running"])))
      .limit(1);
    if (active) {
      throw new DiagnosisServiceError(
        "이미 진행 중인 진단이 있습니다. 끝난 뒤에 새 진단을 시작해 주세요.",
        409,
      );
    }
    const recent = await tx
      .select({ id: diagnoses.id })
      .from(diagnoses)
      .where(and(eq(diagnoses.userId, userId), gte(diagnoses.createdAt, new Date(now.getTime() - 86_400_000))));
    if (recent.length >= limit) {
      throw new DiagnosisServiceError(
        `하루에 진단은 ${limit}건까지 할 수 있습니다. 24시간 안에 만든 진단이 줄어들면 다시 시도해 주세요.`,
        429,
      );
    }

    await tx.insert(diagnoses).values({
      id,
      userId,
      title: diagnosisTitle(input.targetRole, input.resumeFileName, now),
      targetRole: input.targetRole,
      situation: input.situation,
      notes: input.notes,
      jdText: input.jdText,
      resumeText: input.resumeText,
      resumeFileName: input.resumeFileName,
      status: "queued",
      model: currentModelName(),
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .insert(diagnosisStages)
      .values(STAGE_KEYS.map((stage) => ({ diagnosisId: id, stage, status: "pending" as const })));
  });

  return { id };
}

/**
 * queued/running인데 updatedAt이 10분 넘게 갱신되지 않은 진단을 failed로 바꾼다(서버 재시작 등으로 끊긴 실행).
 * userId를 주면 그 사용자의 진단만 본다. 바꾼 건수를 반환.
 */
export async function markStaleRunsFailed(userId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const conds = [inArray(diagnoses.status, ["queued", "running"]), lt(diagnoses.updatedAt, cutoff)];
  if (userId) conds.push(eq(diagnoses.userId, userId));

  const stale = await db
    .select({ id: diagnoses.id })
    .from(diagnoses)
    .where(and(...conds));
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.id);
  const now = new Date();

  await db
    .update(diagnoses)
    .set({ status: "failed", error: STALE_MESSAGE, updatedAt: now })
    .where(and(inArray(diagnoses.id, ids), inArray(diagnoses.status, ["queued", "running"])));
  await db
    .update(diagnosisStages)
    .set({ status: "failed", error: "시간 초과로 중단됨", finishedAt: now })
    .where(and(inArray(diagnosisStages.diagnosisId, ids), eq(diagnosisStages.status, "running")));
  return ids.length;
}

/** 삭제했으면 true, 없거나 남의 것이면 false. 단계 행은 FK cascade로 지워진다. */
export async function deleteDiagnosis(id: string, userId: string): Promise<boolean> {
  // FK cascade는 PRAGMA foreign_keys에 의존하므로 단계 행도 명시적으로 지운다.
  const owned = await db
    .select({ id: diagnoses.id })
    .from(diagnoses)
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)))
    .limit(1);
  if (owned.length === 0) return false;
  await db.delete(diagnosisStages).where(eq(diagnosisStages.diagnosisId, id));
  await db.delete(diagnoses).where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)));
  return true;
}

/** 공유 토큰을 만들거나 이미 있으면 그대로 돌려준다. 완료된 진단만 공유할 수 있다. */
export async function setShareToken(id: string, userId: string): Promise<string> {
  const found = await getDiagnosisRow(id, userId);
  if (found.shareToken) return found.shareToken;
  if (found.status !== "done") {
    throw new DiagnosisServiceError("진단이 끝난 뒤에 공유 링크를 만들 수 있습니다.", 409);
  }
  const token = nanoid(21);
  await db
    .update(diagnoses)
    .set({ shareToken: token })
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)));
  return token;
}

export async function clearShareToken(id: string, userId: string): Promise<void> {
  await getDiagnosisRow(id, userId);
  await db
    .update(diagnoses)
    .set({ shareToken: null })
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)));
}

/**
 * 재시도 준비: 실패·중단된 단계를 pending으로 되돌리고 진단을 queued로. done 단계는 그대로 둬서 이어서 실행된다.
 * 호출자가 이후 after()로 runDiagnosis(id)를 예약한다.
 */
export async function prepareRetry(id: string, userId: string): Promise<void> {
  await markStaleRunsFailed(userId);
  const found = await getDiagnosisRow(id, userId);
  if (found.status === "done") {
    throw new DiagnosisServiceError("이미 완료된 진단입니다.", 409);
  }
  if (found.status === "queued" || found.status === "running") {
    throw new DiagnosisServiceError("진단이 아직 진행 중입니다.", 409);
  }
  const [other] = await db
    .select({ id: diagnoses.id })
    .from(diagnoses)
    .where(and(eq(diagnoses.userId, userId), inArray(diagnoses.status, ["queued", "running"])))
    .limit(1);
  if (other) {
    throw new DiagnosisServiceError(
      "다른 진단이 진행 중입니다. 끝난 뒤에 다시 시도해 주세요.",
      409,
    );
  }

  const now = new Date();
  await db
    .update(diagnosisStages)
    .set({ status: "pending", error: null, startedAt: null, finishedAt: null })
    .where(and(eq(diagnosisStages.diagnosisId, id), inArray(diagnosisStages.status, ["failed", "running"])));
  // 예전 버전에서 빠진 단계 행이 있으면 채운다.
  const existing = new Set((await loadStages(id)).map((s) => s.stage));
  const missing = STAGE_KEYS.filter((k) => !existing.has(k));
  if (missing.length > 0) {
    await db.insert(diagnosisStages).values(missing.map((stage) => ({ diagnosisId: id, stage })));
  }
  await db
    .update(diagnoses)
    .set({ status: "queued", error: null, updatedAt: now, completedAt: null })
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)));
}

async function getDiagnosisRow(id: string, userId: string): Promise<Diagnosis> {
  const [row] = await db
    .select()
    .from(diagnoses)
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)))
    .limit(1);
  if (!row) throw new DiagnosisServiceError("진단을 찾을 수 없습니다.", 404);
  return row;
}
