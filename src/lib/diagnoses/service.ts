import "server-only";
import { and, count, desc, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { diagnoses, diagnosisRuns, diagnosisStages, type Diagnosis, type DiagnosisStage } from "@/lib/db/schema";
import { REVIEWER_IDS, STAGE_KEYS, type DiagnosisInput, type StageKey } from "@/lib/domain/schemas";
import type { ProviderId } from "@/lib/domain/providers";
import { defaultProvider, modelNameFor } from "@/lib/llm";
import {
  dailyDiagnosisLimit,
  diagnosisSubtitle,
  diagnosisTitle,
  matchScoreOf,
  MAX_RETRIES_PER_DIAGNOSIS,
  positiveCountOf,
  STALE_AFTER_MS,
} from "./summary";
import type { DiagnosisListItem } from "./types";
import { DiagnosisServiceError } from "./errors";

export { DiagnosisServiceError };

export type { DiagnosisListItem, DiagnosisStatusResponse } from "./types";

const STALE_MESSAGE =
  "진단 실행이 중간에 끊겼습니다(서버 시간 제한 또는 재시작). 다시 시도하면 끝난 단계는 건너뛰고 이어서 진행합니다.";
const ACTIVE: ("queued" | "running")[] = ["queued", "running"];
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
      resumeFileName: diagnoses.resumeFileName,
    })
    .from(diagnoses)
    .where(eq(diagnoses.userId, userId))
    .orderBy(desc(diagnoses.createdAt))
    .limit(200);
  if (rows.length === 0) return [];

  const summaryStages: StageKey[] = [...REVIEWER_IDS, "fit", "jd"];
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
    const hasJd = !!r.jdText;
    return {
      id: r.id,
      title: r.title,
      subtitle: diagnosisSubtitle({
        targetRole: r.targetRole,
        jdOutput: stages.find((s) => s.stage === "jd")?.output,
        resumeFileName: r.resumeFileName,
        hasJd,
      }),
      targetRole: r.targetRole,
      status: r.status,
      positiveCount: positiveCountOf(stages),
      matchScore: matchScoreOf(stages),
      createdAt: r.createdAt,
      hasJd,
    };
  });
}

/**
 * 진단 행 + 13개 단계 행(pending)을 만든다. 실행(runDiagnosis)은 호출자가 after()로 예약한다.
 * 제한: 사용자당 진행 중(queued/running) 1건(409), 최근 24시간 DAILY_DIAGNOSIS_LIMIT건(429).
 * 하루 제한은 실행 원장(diagnosis_runs)으로 센다 — 진단을 지워도 횟수가 돌아오지 않는다.
 * provider는 호출자가 검증한 엔진(providers/options.ts resolveRequestedProvider). 재시도도 이 엔진으로 한다.
 */
export async function createDiagnosis(
  userId: string,
  input: DiagnosisInput,
  provider: ProviderId = defaultProvider(),
): Promise<{ id: string }> {
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
    const [recent] = await tx
      .select({ n: count() })
      .from(diagnosisRuns)
      .where(
        and(
          eq(diagnosisRuns.userId, userId),
          eq(diagnosisRuns.kind, "create"),
          gte(diagnosisRuns.createdAt, new Date(now.getTime() - 86_400_000)),
        ),
      );
    if ((recent?.n ?? 0) >= limit) {
      throw new DiagnosisServiceError(
        `하루에 진단은 ${limit}건까지 할 수 있습니다(삭제한 진단도 셉니다). 24시간이 지나면 다시 시도해 주세요.`,
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
      model: modelNameFor(provider),
      provider,
      createdAt: now,
      updatedAt: now,
    });
    await tx
      .insert(diagnosisStages)
      .values(STAGE_KEYS.map((stage) => ({ diagnosisId: id, stage, status: "pending" as const })));
    await tx.insert(diagnosisRuns).values({ userId, diagnosisId: id, kind: "create", createdAt: now });
  });

  return { id };
}

/**
 * queued/running인데 updatedAt이 STALE_AFTER_MS 넘게 갱신되지 않은 진단을 failed로 바꾼다.
 * 실행 중에는 runner가 HEARTBEAT_MS마다 updatedAt을 갱신하므로, 이 조건은 실행 프로세스가 죽었다는 뜻이다
 * (함수 시간 초과·서버 재시작).
 * userId를 주면 그 사용자의 진단만 본다. 바꾼 건수를 반환.
 */
export async function markStaleRunsFailed(userId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const conds = [inArray(diagnoses.status, ACTIVE), lt(diagnoses.updatedAt, cutoff)];
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
    .where(and(inArray(diagnoses.id, ids), inArray(diagnoses.status, ACTIVE), lt(diagnoses.updatedAt, cutoff)));
  await db
    .update(diagnosisStages)
    .set({ status: "failed", error: "시간 초과로 중단됨", finishedAt: now })
    .where(and(inArray(diagnosisStages.diagnosisId, ids), eq(diagnosisStages.status, "running")));
  return ids.length;
}

/**
 * 삭제했으면 true, 없거나 남의 것이면 false. 진행 중(queued/running)인 진단은 409 — 실행 중인 파이프라인은
 * 취소할 수 없으므로, 삭제로 '동시 1건' 제한을 우회하지 못하게 막는다. 하루 제한은 원장(diagnosis_runs)으로 세므로
 * 삭제해도 줄지 않는다.
 */
export async function deleteDiagnosis(id: string, userId: string): Promise<boolean> {
  // 상태 확인과 삭제를 한 문장으로 해서, 확인 직후 재시도가 시작되는 경쟁을 막는다.
  const deleted = await db
    .delete(diagnoses)
    .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId), notInArray(diagnoses.status, ACTIVE)))
    .returning({ id: diagnoses.id });
  if (deleted.length === 0) {
    const [row] = await db
      .select({ id: diagnoses.id })
      .from(diagnoses)
      .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)))
      .limit(1);
    if (!row) return false;
    throw new DiagnosisServiceError("진행 중인 진단은 삭제할 수 없습니다. 끝나거나 중단된 뒤에 삭제해 주세요.", 409);
  }
  // FK cascade는 PRAGMA foreign_keys에 의존하므로 단계 행도 명시적으로 지운다.
  await db.delete(diagnosisStages).where(eq(diagnosisStages.diagnosisId, id));
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
 * 한 트랜잭션 안에서 '다른 진행 중 진단 없음'을 확인하고 failed → queued로 조건부 전환한다(생성과 같은 잠금).
 * 진단 하나당 MAX_RETRIES_PER_DIAGNOSIS회까지(원장으로 센다). 호출자가 이후 after()로 runDiagnosis(id)를 예약한다.
 */
export async function prepareRetry(id: string, userId: string): Promise<void> {
  await markStaleRunsFailed(userId);
  const now = new Date();

  await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ status: diagnoses.status })
      .from(diagnoses)
      .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId)))
      .limit(1);
    if (!found) throw new DiagnosisServiceError("진단을 찾을 수 없습니다.", 404);
    if (found.status === "done") throw new DiagnosisServiceError("이미 완료된 진단입니다.", 409);
    if (found.status !== "failed") throw new DiagnosisServiceError("진단이 아직 진행 중입니다.", 409);

    const [other] = await tx
      .select({ id: diagnoses.id })
      .from(diagnoses)
      .where(and(eq(diagnoses.userId, userId), inArray(diagnoses.status, ACTIVE)))
      .limit(1);
    if (other) {
      throw new DiagnosisServiceError("다른 진단이 진행 중입니다. 끝난 뒤에 다시 시도해 주세요.", 409);
    }

    const [retries] = await tx
      .select({ n: count() })
      .from(diagnosisRuns)
      .where(and(eq(diagnosisRuns.diagnosisId, id), eq(diagnosisRuns.kind, "retry")));
    if ((retries?.n ?? 0) >= MAX_RETRIES_PER_DIAGNOSIS) {
      throw new DiagnosisServiceError(
        `이 진단은 이미 ${MAX_RETRIES_PER_DIAGNOSIS}번 재시도했습니다. 새 진단으로 다시 시작해 주세요.`,
        429,
      );
    }

    const switched = await tx
      .update(diagnoses)
      .set({ status: "queued", error: null, updatedAt: now, completedAt: null })
      .where(and(eq(diagnoses.id, id), eq(diagnoses.userId, userId), eq(diagnoses.status, "failed")))
      .returning({ id: diagnoses.id });
    if (switched.length === 0) throw new DiagnosisServiceError("진단 상태가 바뀌었습니다. 새로고침해 주세요.", 409);

    await tx
      .update(diagnosisStages)
      .set({ status: "pending", error: null, startedAt: null, finishedAt: null })
      .where(and(eq(diagnosisStages.diagnosisId, id), inArray(diagnosisStages.status, ["failed", "running"])));
    // 예전 버전에서 빠진 단계 행이 있으면 채운다.
    await tx
      .insert(diagnosisStages)
      .values(STAGE_KEYS.map((stage) => ({ diagnosisId: id, stage })))
      .onConflictDoNothing();
    await tx.insert(diagnosisRuns).values({ userId, diagnosisId: id, kind: "retry", createdAt: now });
  });
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
