/**
 * 진단 하나를 DB에서 읽어 끝까지 실행하고 결과를 단계마다 저장한다. 예외를 밖으로 던지지 않는다.
 * - 동시 실행 방지: 진단 상태를 queued/failed → running으로 조건부 갱신하며 새 runId를 정한다. 바뀐 행이 없으면 끝낸다.
 * - 실행 식별: 이후 모든 쓰기(진단·단계 행)는 "status=running AND run_id=내 runId"일 때만 반영된다. 멈춘 실행으로
 *   판정(markStaleRunsFailed)되고 재시도가 새 실행을 시작하면, 예전 실행의 늦은 쓰기는 아무 행에도 닿지 않는다.
 *   (Postgres READ COMMITTED에서 조건부 UPDATE는 잠금 뒤 조건을 다시 보므로, 경쟁하는 두 실행 중 하나만 차지한다.)
 * - 하트비트: HEARTBEAT_MS마다 updatedAt을 갱신한다. 갱신이 0행이면(중단 판정·삭제·다른 실행이 차지) 파이프라인을
 *   중단(AbortSignal)해 더 이상 LLM을 부르지 않는다.
 * - 시간 예산: opts.deadlineAt이 있으면 그 시각에 중단하고 실패로 기록한다(함수 시간 제한에 강제 종료되기 전에).
 */
import "server-only";
import { nanoid } from "nanoid";
import { Prisma, prisma } from "@/lib/db/client";
import { stripNulDeep } from "@/lib/db/errors";
import type { Diagnosis, UsageTotals } from "@/lib/db/types";
import { STAGE_LABELS } from "@/lib/domain/reviewers";
import { STAGE_KEYS, STAGE_SCHEMAS, type StageKey, type StageOutputs } from "@/lib/domain/schemas";
import { DEADLINE_STOP_ERROR, HEARTBEAT_MS } from "@/lib/diagnoses/summary";
import { createLlmClient, legacyProvider } from "@/lib/llm";
import { LlmPermanentError, usageOfError, type LlmClient, type LlmUsage } from "@/lib/llm/types";
import { runPipeline } from "./pipeline";
import type { PanelInput } from "./prompts";

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** 단계 실패 사유를 사용자에게 보여줄 한국어 문장으로. */
export function stageErrorMessage(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "APIUserAbortError" || name === "RunAbortedError") {
    const reason = (error as { reason?: unknown }).reason;
    return reason === "deadline"
      ? "서버 실행 시간 제한에 걸려 중단되었습니다. 다시 시도하면 끝난 단계는 건너뛰고 이어서 진행합니다."
      : "실행이 중단되었습니다. 다시 시도해 주세요.";
  }
  if (error instanceof LlmPermanentError) {
    switch (error.reason) {
      case "refusal":
        return "AI 모델이 이 단계의 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요.";
      case "invalid_output":
        return "AI 응답이 정해진 형식과 맞지 않았습니다(재요청 후에도 실패). 다시 시도해 주세요.";
      case "max_tokens":
        return "AI 응답이 서버의 출력 길이 한도에서 끊겼습니다(한도를 올려 다시 요청한 뒤에도). 다시 시도해 주세요.";
      case "context_window":
        return "이력서와 공고를 합친 입력이 AI 모델이 한 번에 읽을 수 있는 양을 넘었습니다. 줄여서 다시 진단해 주세요.";
      case "bad_request":
        return "AI 서비스가 요청을 받아들이지 않았습니다(입력이 너무 길거나 형식 오류).";
      case "auth":
        return "AI 계정 로그인이 없거나 만료되었습니다. 'AI 연결' 화면에서 다시 로그인한 뒤 재시도해 주세요.";
      case "usage_limit":
        return "연결된 AI 계정의 사용량 한도에 걸렸습니다. 한도가 풀린 뒤 다시 시도해 주세요.";
      case "unavailable":
        return "선택한 AI 엔진을 지금 쓸 수 없습니다(CLI 미설치 또는 기능 꺼짐). 'AI 연결' 화면을 확인해 주세요.";
      case "timeout":
        return "AI 응답이 제한 시간 안에 오지 않았습니다. 다시 시도해 주세요.";
    }
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    if (status === 429) return "AI 서비스 요청 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.";
    if (status === 401 || status === 403) return "AI 서비스 인증에 실패했습니다. 관리자에게 문의해 주세요.";
    if (status >= 500) return `AI 서비스에 일시적인 장애가 있습니다(상태 ${status}). 잠시 뒤 다시 시도해 주세요.`;
    return `AI 서비스 호출에 실패했습니다(상태 ${status}).`;
  }
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

/** 실행 중단 사유를 담은 오류(파이프라인의 진행 중 호출을 끊을 때 쓴다). */
class RunAbortedError extends Error {
  constructor(readonly reason: "deadline" | "lost_ownership") {
    super(reason === "deadline" ? "실행 시간 예산 초과" : "실행 소유권 상실(중단 판정·삭제·다른 실행)");
    this.name = "RunAbortedError";
  }
}

export async function runDiagnosis(
  diagnosisId: string,
  opts?: { llm?: LlmClient; deadlineAt?: number; heartbeatMs?: number },
): Promise<void> {
  // 진단 행 갱신은 순서대로 한다(사용량 누적값이 늦게 쓰인 작은 값으로 덮이지 않도록).
  let chain: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<unknown>) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const runId = nanoid();
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const mine = { id: diagnosisId, runId, status: "running" } satisfies Prisma.DiagnosisWhereInput;
  const loseOwnership = () => {
    if (!controller.signal.aborted) controller.abort(new RunAbortedError("lost_ownership"));
  };

  try {
    const claimed = await prisma.diagnosis.updateMany({
      where: { id: diagnosisId, status: { in: ["queued", "failed"] } },
      data: { status: "running", runId, error: null, completedAt: null, updatedAt: new Date() },
    });
    if (claimed.count === 0) return; // 없거나 이미 실행 중/완료

    const diagnosis = (await prisma.diagnosis.findUnique({ where: { id: diagnosisId } })) as Diagnosis | null;
    if (!diagnosis) return;

    // 단계 행이 빠져 있으면 만들고, 끝나지 않은 단계는 pending으로 되돌린다(멈춘 running 정리).
    await prisma.diagnosisStage.createMany({
      data: STAGE_KEYS.map((stage) => ({ diagnosisId, stage })),
      skipDuplicates: true,
    });
    const rows = await prisma.diagnosisStage.findMany({ where: { diagnosisId } });
    const existing = existingOutputs(rows as { stage: StageKey; status: string; output: unknown }[]);
    const rerun = STAGE_KEYS.filter((s) => existing[s] == null);
    if (rerun.length > 0) {
      await prisma.diagnosisStage.updateMany({
        where: { diagnosisId, stage: { in: rerun } },
        data: { status: "pending", error: null, output: Prisma.DbNull, startedAt: null, finishedAt: null },
      });
    }

    const input: PanelInput = {
      resumeText: diagnosis.resumeText,
      resumeFileName: diagnosis.resumeFileName,
      targetRole: diagnosis.targetRole,
      jdText: diagnosis.jdText?.trim() ? diagnosis.jdText : null,
      situation: diagnosis.situation,
      notes: diagnosis.notes?.trim() ? diagnosis.notes : null,
      portfolioText: diagnosis.portfolioText?.trim() ? diagnosis.portfolioText : null,
    };

    let usage: UsageTotals = { ...ZERO_USAGE, ...(diagnosis.usage ?? {}) };
    const failed: StageKey[] = [];
    // 단계 행 쓰기도 이 실행이 아직 진단을 소유할 때만 반영한다.
    // (관계 필터 → EXISTS 서브쿼리)
    const stageWhere = (stage: StageKey): Prisma.DiagnosisStageWhereInput => ({
      diagnosisId,
      stage,
      diagnosis: { is: { runId, status: "running" } },
    });
    const writeStage = async (stage: StageKey, values: Prisma.DiagnosisStageUpdateManyMutationInput) => {
      const rows = await prisma.diagnosisStage.updateMany({ where: stageWhere(stage), data: values });
      if (rows.count === 0) loseOwnership();
    };
    const touch = (extra: { usage?: UsageTotals } = {}) =>
      serial(async () => {
        const rows = await prisma.diagnosis.updateMany({
          where: mine,
          data: { updatedAt: new Date(), ...(extra.usage ? { usage: { ...extra.usage } } : {}) },
        });
        if (rows.count === 0) loseOwnership();
      });

    heartbeat = setInterval(() => void touch().catch(() => undefined), opts?.heartbeatMs ?? HEARTBEAT_MS);
    if (opts?.deadlineAt) {
      deadlineTimer = setTimeout(
        () => controller.abort(new RunAbortedError("deadline")),
        Math.max(0, opts.deadlineAt - Date.now()),
      );
    }

    const { ok } = await runPipeline(input, {
      llm: opts?.llm ?? createLlmClient(diagnosis.provider ?? legacyProvider(diagnosis.model), { userId: diagnosis.userId, referenceId: diagnosis.id }),
      existing,
      signal: controller.signal,
      async onStageStart(stage) {
        if (controller.signal.aborted) throw controller.signal.reason;
        await writeStage(stage, { status: "running", error: null, startedAt: new Date(), finishedAt: null });
        await touch();
      },
      async onStageDone(stage, output, stageUsage) {
        // jsonb는 NUL(\u0000)을 받지 않는다 — LLM 출력의 문자열에서 지운다.
        const json = stripNulDeep(output) as Prisma.InputJsonValue;
        await writeStage(stage, { status: "done", output: json, error: null, finishedAt: new Date() });
        usage = addUsage(usage, stageUsage);
        const snapshot = usage;
        await touch({ usage: snapshot });
      },
      async onStageFailed(stage, error) {
        failed.push(stage);
        console.error(`[runDiagnosis] ${diagnosisId} ${stage} 실패:`, error);
        // 실패한 단계도 그때까지 쓴 토큰은 사용량에 넣는다.
        const spent = usageOfError(error);
        if (spent) usage = addUsage(usage, spent);
        // 중단(시간 예산·소유권 상실)으로 끊긴 호출은 원인을 단계 오류로 보여 준다.
        const shown = controller.signal.aborted ? (controller.signal.reason ?? error) : error;
        await writeStage(stage, { status: "failed", error: stageErrorMessage(shown), finishedAt: new Date() });
        const snapshot = usage;
        await touch({ usage: snapshot });
      },
    });

    clearInterval(heartbeat);
    await chain;
    const now = new Date();
    const deadlineHit = (controller.signal.reason as RunAbortedError | undefined)?.reason === "deadline";
    const error = ok
      ? null
      : deadlineHit
        ? DEADLINE_STOP_ERROR
        : failed.length > 0
          ? `${failed.map((s) => STAGE_LABELS[s]).join(", ")} 단계가 실패했습니다. 다시 시도하면 완료된 단계는 건너뛰고 이어서 진행합니다.`
          : "일부 단계를 완료하지 못했습니다. 다시 시도해 주세요.";
    // 이 실행이 아직 소유한 경우에만 최종 상태를 쓴다(멈춤 판정 뒤 다른 실행이 시작됐으면 건드리지 않는다).
    await prisma.diagnosis.updateMany({
      where: mine,
      data: { status: ok ? "done" : "failed", error, completedAt: ok ? now : null, updatedAt: now, usage: { ...usage } },
    });
  } catch (e) {
    console.error(`[runDiagnosis] ${diagnosisId} 실행 오류:`, e);
    try {
      clearInterval(heartbeat);
      await chain;
      await prisma.diagnosis.updateMany({
        where: { id: diagnosisId, runId, status: { not: "done" } },
        data: { status: "failed", error: "진단을 실행하는 중 오류가 발생했습니다. 다시 시도해 주세요.", updatedAt: new Date() },
      });
    } catch (e2) {
      console.error(`[runDiagnosis] ${diagnosisId} 실패 상태 기록 실패:`, e2);
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadlineTimer);
  }
}
