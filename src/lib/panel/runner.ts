/**
 * 진단 하나를 DB에서 읽어 끝까지 실행하고 결과를 단계마다 저장한다. 예외를 밖으로 던지지 않는다.
 * 동시 실행 방지: 진단 상태를 queued/failed → running으로 조건부 갱신하고, 바뀐 행이 없으면 바로 끝낸다.
 */
import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { diagnoses, diagnosisStages, type UsageTotals } from "@/lib/db/schema";
import { STAGE_LABELS } from "@/lib/domain/reviewers";
import { STAGE_KEYS, STAGE_SCHEMAS, type DiagnosisInput, type StageKey, type StageOutputs } from "@/lib/domain/schemas";
import { createLlmClient } from "@/lib/llm";
import { LlmPermanentError, type LlmClient, type LlmUsage } from "@/lib/llm/types";
import { runPipeline } from "./pipeline";

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 단계 실패 사유를 사용자에게 보여줄 한국어 문장으로. */
export function stageErrorMessage(error: unknown): string {
  if (error instanceof LlmPermanentError) {
    switch (error.reason) {
      case "refusal":
        return "AI 모델이 이 단계의 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요.";
      case "invalid_output":
        return "AI 응답이 정해진 형식과 맞지 않았습니다(재요청 후에도 실패). 다시 시도해 주세요.";
      case "max_tokens":
        return "AI 응답이 길이 제한에서 끊겼습니다. 이력서나 공고가 너무 길면 줄여서 다시 시도해 주세요.";
      case "bad_request":
        return "AI 서비스가 요청을 받아들이지 않았습니다(입력이 너무 길거나 형식 오류).";
    }
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    if (status === 429) return "AI 서비스 요청 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.";
    if (status === 401 || status === 403) return "AI 서비스 인증에 실패했습니다. 관리자에게 문의해 주세요.";
    if (status >= 500) return `AI 서비스에 일시적인 장애가 있습니다(상태 ${status}). 잠시 뒤 다시 시도해 주세요.`;
    return `AI 서비스 호출에 실패했습니다(상태 ${status}).`;
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
    return "AI 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  return "이 단계를 실행하는 중 오류가 발생했습니다. 다시 시도해 주세요.";
}

function addUsage(a: UsageTotals, b: LlmUsage): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** 저장된 단계 출력 중 스키마를 통과하는 done 단계만 재개용으로 쓴다. */
function existingOutputs(rows: { stage: StageKey; status: string; output: unknown }[]): Partial<StageOutputs> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.status !== "done" || row.output == null || !STAGE_KEYS.includes(row.stage)) continue;
    const parsed = STAGE_SCHEMAS[row.stage].safeParse(row.output);
    if (parsed.success) out[row.stage] = parsed.data;
  }
  return out as Partial<StageOutputs>;
}

export async function runDiagnosis(diagnosisId: string, opts?: { llm?: LlmClient }): Promise<void> {
  // 진단 행 갱신은 순서대로 한다(사용량 누적값이 늦게 쓰인 작은 값으로 덮이지 않도록).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<unknown>) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  try {
    const claimed = await db
      .update(diagnoses)
      .set({ status: "running", error: null, completedAt: null, updatedAt: new Date() })
      .where(and(eq(diagnoses.id, diagnosisId), inArray(diagnoses.status, ["queued", "failed"])))
      .returning({ id: diagnoses.id });
    if (claimed.length === 0) return; // 없거나 이미 실행 중/완료

    const diagnosis = await db.query.diagnoses.findFirst({ where: eq(diagnoses.id, diagnosisId) });
    if (!diagnosis) return;

    // 단계 행이 빠져 있으면 만들고, 끝나지 않은 단계는 pending으로 되돌린다(멈춘 running 정리).
    await db
      .insert(diagnosisStages)
      .values(STAGE_KEYS.map((stage) => ({ diagnosisId, stage })))
      .onConflictDoNothing();
    const rows = await db.select().from(diagnosisStages).where(eq(diagnosisStages.diagnosisId, diagnosisId));
    const existing = existingOutputs(rows);
    const rerun = STAGE_KEYS.filter((s) => existing[s] == null);
    if (rerun.length > 0) {
      await db
        .update(diagnosisStages)
        .set({ status: "pending", error: null, output: null, startedAt: null, finishedAt: null })
        .where(and(eq(diagnosisStages.diagnosisId, diagnosisId), inArray(diagnosisStages.stage, rerun)));
    }

    const input: DiagnosisInput = {
      resumeText: diagnosis.resumeText,
      resumeFileName: diagnosis.resumeFileName,
      targetRole: diagnosis.targetRole,
      jdText: diagnosis.jdText?.trim() ? diagnosis.jdText : null,
      situation: diagnosis.situation,
      notes: diagnosis.notes?.trim() ? diagnosis.notes : null,
    };

    let usage: UsageTotals = { ...ZERO_USAGE, ...(diagnosis.usage ?? {}) };
    const failed: StageKey[] = [];
    const stageWhere = (stage: StageKey) =>
      and(eq(diagnosisStages.diagnosisId, diagnosisId), eq(diagnosisStages.stage, stage));
    const touch = (extra: Partial<typeof diagnoses.$inferInsert> = {}) =>
      serial(() => db.update(diagnoses).set({ updatedAt: new Date(), ...extra }).where(eq(diagnoses.id, diagnosisId)));

    const { ok } = await runPipeline(input, {
      llm: opts?.llm ?? createLlmClient(),
      existing,
      async onStageStart(stage) {
        await db
          .update(diagnosisStages)
          .set({ status: "running", error: null, startedAt: new Date(), finishedAt: null })
          .where(stageWhere(stage));
        await touch();
      },
      async onStageDone(stage, output, stageUsage) {
        await db
          .update(diagnosisStages)
          .set({ status: "done", output, error: null, finishedAt: new Date() })
          .where(stageWhere(stage));
        usage = addUsage(usage, stageUsage);
        const snapshot = usage;
        await touch({ usage: snapshot });
      },
      async onStageFailed(stage, error) {
        failed.push(stage);
        console.error(`[runDiagnosis] ${diagnosisId} ${stage} 실패:`, error);
        await db
          .update(diagnosisStages)
          .set({ status: "failed", error: stageErrorMessage(error), finishedAt: new Date() })
          .where(stageWhere(stage));
        await touch();
      },
    });

    await chain;
    const now = new Date();
    const error = ok
      ? null
      : failed.length > 0
        ? `${failed.map((s) => STAGE_LABELS[s]).join(", ")} 단계가 실패했습니다. 다시 시도하면 완료된 단계는 건너뛰고 이어서 진행합니다.`
        : "일부 단계를 완료하지 못했습니다. 다시 시도해 주세요.";
    await db
      .update(diagnoses)
      .set({ status: ok ? "done" : "failed", error, completedAt: ok ? now : null, updatedAt: now, usage })
      .where(and(eq(diagnoses.id, diagnosisId), eq(diagnoses.status, "running")));
  } catch (e) {
    console.error(`[runDiagnosis] ${diagnosisId} 실행 오류:`, e);
    try {
      await chain;
      await db
        .update(diagnoses)
        .set({ status: "failed", error: "진단을 실행하는 중 오류가 발생했습니다. 다시 시도해 주세요.", updatedAt: new Date() })
        .where(and(eq(diagnoses.id, diagnosisId), ne(diagnoses.status, "done")));
    } catch (e2) {
      console.error(`[runDiagnosis] ${diagnosisId} 실패 상태 기록 실패:`, e2);
    }
  }
}
