/**
 * DB와 무관한 순수 오케스트레이션. STAGE_DEPENDENCIES를 따라 의존이 끝난 단계를 즉시(동시에) 시작한다.
 * - deps.existing에 있는 단계는 이미 끝난 것으로 보고 건너뛴다(재개).
 * - 의존 단계가 실패하면 그 뒤 단계는 실행하지 않는다(콜백도 호출하지 않음 → pending으로 남는다).
 * - 콜백이 던진 예외는 해당 단계의 실패로 처리한다. 이 함수는 예외를 던지지 않는다.
 * - deps.signal이 중단되면 아직 시작하지 않은 단계는 시작하지 않는다(진행 중 호출은 SDK가 signal로 끊는다).
 */
import { STAGE_DEPENDENCIES, STAGE_KEYS, STAGE_SCHEMAS } from "@/lib/domain/schemas";
import type { StageKey, StageOutputs } from "@/lib/domain/schemas";
import type { LlmClient, LlmUsage } from "@/lib/llm/types";
import type { z } from "zod";
import { scoreFit } from "./fit-score";
import { buildStagePrompt, type PanelInput } from "./prompts";

/**
 * 모델 출력의 파생 값을 코드로 다시 계산한다. 지금은 fit.matchScore 하나 — 모델의 산수 대신 매트릭스에서 계산해
 * 저장하므로 이후 단계(synthesis·plan)와 보고서·이력 목록이 같은 점수를 본다.
 */
export function normalizeStageOutput<K extends StageKey>(
  stage: K,
  output: StageOutputs[K],
  outputs: Partial<StageOutputs>,
): StageOutputs[K] {
  if (stage === "fit" && outputs.jd) {
    const fit = output as StageOutputs["fit"];
    return { ...fit, matchScore: scoreFit(outputs.jd, fit) } as StageOutputs[K];
  }
  return output;
}

export interface PipelineDeps {
  llm: LlmClient;
  existing: Partial<StageOutputs>;
  onStageStart(stage: StageKey): Promise<void>;
  onStageDone<K extends StageKey>(stage: K, output: StageOutputs[K], usage: LlmUsage): Promise<void>;
  onStageFailed(stage: StageKey, error: Error): Promise<void>;
  signal?: AbortSignal;
}

type State = "done" | "failed" | "blocked";

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** input.portfolioText가 있으면 리뷰어·fit·synthesis·rewrite·plan 프롬프트에 이력서와 별개 자료로 들어간다. */
export async function runPipeline(input: PanelInput, deps: PipelineDeps): Promise<{ ok: boolean }> {
  const outputs: Partial<StageOutputs> = { ...deps.existing };
  const state = new Map<StageKey, State>();
  for (const stage of STAGE_KEYS) if (outputs[stage] != null) state.set(stage, "done");

  const inflight = new Map<StageKey, Promise<void>>();

  async function runStage<K extends StageKey>(stage: K): Promise<void> {
    try {
      await deps.onStageStart(stage);
      const prompt = buildStagePrompt(stage, input, outputs);
      const schema = STAGE_SCHEMAS[stage] as unknown as z.ZodType<StageOutputs[K]>;
      const result = await deps.llm.generate({ stage, schema, signal: deps.signal, ...prompt });
      const output = normalizeStageOutput(stage, result.output, outputs);
      await deps.onStageDone(stage, output, result.usage);
      outputs[stage] = output;
      state.set(stage, "done");
    } catch (e) {
      state.set(stage, "failed");
      try {
        await deps.onStageFailed(stage, toError(e));
      } catch {
        // 실패 기록 자체가 실패해도 파이프라인은 계속 정리한다.
      }
    }
  }

  for (;;) {
    // STAGE_KEYS는 위상 정렬 순서라 한 번 훑으면 blocked 전파가 끝난다.
    for (const stage of STAGE_KEYS) {
      if (state.has(stage) || inflight.has(stage)) continue;
      if (deps.signal?.aborted) {
        state.set(stage, "blocked");
        continue;
      }
      const depStates = STAGE_DEPENDENCIES[stage].map((d) => state.get(d));
      if (depStates.some((s) => s === "failed" || s === "blocked")) {
        state.set(stage, "blocked");
      } else if (depStates.every((s) => s === "done")) {
        const p = runStage(stage).finally(() => inflight.delete(stage));
        inflight.set(stage, p);
      }
    }
    if (inflight.size === 0) break;
    await Promise.race(inflight.values());
  }

  return { ok: STAGE_KEYS.every((s) => state.get(s) === "done") };
}
