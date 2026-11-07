/**
 * 다음 단계 계산(순수). 저장된 단계 행만으로 결정하므로 어느 함수 호출이 이어받아도 같은 답이 나온다.
 *   round 0: jd → retrieve → plan → write_body → write_top → review
 *   round k: (종료 판정) → revise → review   (k = 1..maxRevisions)
 *   끝: final_panel(예산이 남을 때) → finalize
 * - 출력이 스키마를 통과하지 못하는 done 행(배포 사이 스키마 변경)은 다시 실행할 단계로 본다.
 * - 'failed' 행: 시도를 다 썼거나 영구 오류. round 0 단계면 작업 실패, review·revise면 가장 좋은 검증 초안으로 마무리(review_failed),
 *   final_panel이면 건너뛴다(리포트 finalPanel = null).
 */
import type { AgentStepKind, SectionId } from "./job-types";
import { stepKey } from "./job-types";
import {
  BriefStepOutputSchema,
  ComposeStepOutputSchema,
  CritiqueStepOutputSchema,
  SectionStepOutputSchema,
  FinalPanelStepOutputSchema,
  FinalizeStepOutputSchema,
  JdStepOutputSchema,
  PlanStepOutputSchema,
  RetrieveStepOutputSchema,
  ReviewStepOutputSchema,
  ReviseStepOutputSchema,
  WriteBodyStepOutputSchema,
  WriteTopStepOutputSchema,
  type AgentDraft,
  type EvidencePack,
  type ReviewRound,
  type StopReason,
} from "./schemas";
import { chooseBestRound, decideStop } from "./stop";
import type { z } from "zod";

export const MAX_STEP_ATTEMPTS = 3;
/** 작업당 토큰 상한(입력+출력, 캐시 읽기 제외). */
export const AGENT_JOB_TOKEN_BUDGET = 500_000;
/** 단계별 토큰 추정(예산 판정용, 실측 전 추정). */
export const STEP_TOKEN_ESTIMATE: Record<AgentStepKind, number> = {
  jd: 15_000,
  retrieve: 0,
  plan: 25_000,
  write_body: 35_000,
  write_top: 20_000,
  review: 50_000,
  revise: 30_000,
  final_panel: 45_000,
  finalize: 0,
  // v2(구역별 값은 next-step-v2.ts SECTION_TOKEN_ESTIMATE)
  brief: 25_000,
  section: 10_000,
  compose: 14_000,
  critique: 20_000,
};
/** 단계 시작 조건에 쓰는 소요 추정(초). 새 호출의 첫 단계는 언제나 시작할 수 있다(최대 180 + 15 < 270). */
export const STEP_ESTIMATE_SEC: Record<AgentStepKind, number> = {
  jd: 60,
  retrieve: 10,
  plan: 90,
  write_body: 180,
  write_top: 90,
  review: 120,
  revise: 150,
  final_panel: 120,
  finalize: 15,
  brief: 90,
  section: 60,
  compose: 60,
  critique: 60,
};
/** 단계 시간 상한(초). 실제 상한 = min(이 값, 남은 시간 − 15초). */
export const STEP_CAP_SEC: Record<AgentStepKind, number> = {
  jd: 120,
  retrieve: 30,
  plan: 150,
  write_body: 230,
  write_top: 150,
  review: 200,
  revise: 200,
  final_panel: 200,
  finalize: 30,
  brief: 150,
  section: 150,
  compose: 150,
  critique: 150,
};

export const STEP_OUTPUT_SCHEMAS = {
  jd: JdStepOutputSchema,
  retrieve: RetrieveStepOutputSchema,
  plan: PlanStepOutputSchema,
  write_body: WriteBodyStepOutputSchema,
  write_top: WriteTopStepOutputSchema,
  review: ReviewStepOutputSchema,
  revise: ReviseStepOutputSchema,
  final_panel: FinalPanelStepOutputSchema,
  finalize: FinalizeStepOutputSchema,
  brief: BriefStepOutputSchema,
  section: SectionStepOutputSchema,
  compose: ComposeStepOutputSchema,
  critique: CritiqueStepOutputSchema,
} as const satisfies Record<AgentStepKind, z.ZodType>;
export type StepOutputs = { [K in AgentStepKind]: z.infer<(typeof STEP_OUTPUT_SCHEMAS)[K]> };

export interface StepRowLike {
  key: string;
  kind: string;
  round: number;
  status: string;
  output: unknown;
  attempt: number;
  usage?: unknown;
}

export interface RunContext {
  maxRevisions: number;
  minFit?: number;
  panel: "core" | "full";
  tokenBudget?: number;
}

export interface NextStep {
  key: string;
  kind: AgentStepKind;
  round: number;
  /** kind 'section'(v2)이면 구역 id. */
  section?: SectionId;
}

export interface RunState {
  /** 실행할 단계. null이면 끝(finalize까지 done) 또는 fail. */
  next: NextStep | null;
  /** 시도를 다 쓴 필수 단계(작업 실패). */
  fail: string | null;
  rounds: ReviewRound[];
  stopReason: StopReason | null;
  chosenRound: number | null;
  usedTokens: number;
  finalPanel: "pending" | "done" | "failed" | "skipped";
}

/** 단계 행의 토큰(입력+출력) 합. */
export function usedTokens(rows: readonly StepRowLike[]): number {
  let n = 0;
  for (const r of rows) {
    const u = r.usage as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined;
    if (u && typeof u.inputTokens === "number") n += u.inputTokens;
    if (u && typeof u.outputTokens === "number") n += u.outputTokens;
  }
  return n;
}

export function parsedOutput<K extends AgentStepKind>(rows: readonly StepRowLike[], kind: K, round: number): StepOutputs[K] | null {
  const row = rows.find((r) => r.key === stepKey(kind, round));
  if (!row || row.status !== "done") return null;
  const parsed = STEP_OUTPUT_SCHEMAS[kind].safeParse(row.output);
  return parsed.success ? (parsed.data as StepOutputs[K]) : null;
}

export function evaluateRun(rows: readonly StepRowLike[], ctx: RunContext): RunState {
  const budget = ctx.tokenBudget ?? AGENT_JOB_TOKEN_BUDGET;
  const used = usedTokens(rows);
  const failed = (key: string) => rows.find((r) => r.key === key)?.status === "failed";
  const state: RunState = { next: null, fail: null, rounds: [], stopReason: null, chosenRound: null, usedTokens: used, finalPanel: "pending" };
  const at = (kind: AgentStepKind, round: number): NextStep => ({ key: stepKey(kind, round), kind, round });

  for (const kind of ["jd", "retrieve", "plan", "write_body", "write_top"] as const) {
    if (parsedOutput(rows, kind, 0)) continue;
    if (failed(stepKey(kind, 0))) return { ...state, fail: stepKey(kind, 0) };
    return { ...state, next: at(kind, 0) };
  }
  const jd = parsedOutput(rows, "jd", 0)!;
  const pickCtx = { jdSource: jd.jd.source, minFit: ctx.minFit, panel: ctx.panel };

  for (let k = 0; k <= 2; k++) {
    const review = parsedOutput(rows, "review", k);
    if (!review) {
      if (failed(stepKey("review", k))) {
        state.stopReason = "review_failed";
        break;
      }
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: at("review", k) };
    }
    state.rounds.push(review.round);
    const decision = decideStop(state.rounds, {
      jdSource: jd.jd.source,
      maxRevisions: ctx.maxRevisions,
      minFit: ctx.minFit,
      panel: ctx.panel,
      overBudget: used + STEP_TOKEN_ESTIMATE.revise + STEP_TOKEN_ESTIMATE.review > budget,
    });
    if (decision.stop) {
      state.stopReason = decision.reason;
      break;
    }
    const revise = parsedOutput(rows, "revise", k + 1);
    if (!revise) {
      if (failed(stepKey("revise", k + 1))) {
        state.stopReason = "review_failed";
        break;
      }
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: at("revise", k + 1) };
    }
    if (revise.noop) {
      state.stopReason = "plateau";
      break;
    }
  }
  state.stopReason ??= "max_rounds";
  state.chosenRound = chooseBestRound(state.rounds, pickCtx);

  // 최종 심사: 심사한 라운드가 있고 예산이 남을 때만.
  if (parsedOutput(rows, "final_panel", -1)) state.finalPanel = "done";
  else if (failed("final_panel")) state.finalPanel = "failed";
  else if (state.rounds.length === 0 || used + STEP_TOKEN_ESTIMATE.final_panel > budget || rows.some((r) => r.key === "final_panel" && r.status === "skipped")) {
    state.finalPanel = "skipped";
  } else return { ...state, next: at("final_panel", -1) };

  if (parsedOutput(rows, "finalize", -1)) return state;
  if (failed("finalize")) return { ...state, fail: "finalize" };
  return { ...state, next: at("finalize", -1) };
}

/** 최신 pack: 가장 최근 revise.output.pack, 없으면 retrieve.output.pack. */
export function currentPack(rows: readonly StepRowLike[], uptoRound = 2): EvidencePack | null {
  for (let k = Math.min(uptoRound, 2); k >= 1; k--) {
    const p = parsedOutput(rows, "revise", k)?.pack;
    if (p) return p;
  }
  return parsedOutput(rows, "retrieve", 0)?.pack ?? null;
}

/** 라운드 k의 문서(0 = write_top, k ≥ 1 = revise k). */
export function draftOfRound(rows: readonly StepRowLike[], k: number): AgentDraft | null {
  if (k <= 0) return parsedOutput(rows, "write_top", 0)?.draft ?? null;
  return parsedOutput(rows, "revise", k)?.draft ?? null;
}

/** 지금까지 있는 가장 최근 검증 초안의 라운드. */
export function latestDraftRound(rows: readonly StepRowLike[]): number | null {
  for (let k = 2; k >= 1; k--) if (draftOfRound(rows, k)) return k;
  return draftOfRound(rows, 0) ? 0 : null;
}
