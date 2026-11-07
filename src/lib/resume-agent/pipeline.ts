/**
 * 단계 계획 버전(v1 전체 작성·패치 / v2 구역별 에이전트)에 상관없이 심사·최종 심사·저장 단계가 읽는 값(순수).
 * review·final_panel·finalize는 이 접근자만 쓰므로 두 계획에서 같은 코드로 돈다(docs/RESUME-SECTION-AGENTS.md §1 "그대로 쓰는 것").
 */
import type { AgentSettings } from "./config";
import { currentPack, draftOfRound, evaluateRun, latestDraftRound, parsedOutput, type NextStep, type StepRowLike } from "./next-step";
import { currentPackV2, draftOfRoundV2, evaluateSectionRun, latestDraftRoundV2, verifyOfRoundV2, type RunStateV2 } from "./next-step-v2";
import type { AgentDraft, EvidencePack, ResumeAgentPlan, VerifyReport } from "./schemas";

export type PipelineVersion = 1 | 2;

export const pipelineOf = (v: number | null | undefined): PipelineVersion => (v === 2 ? 2 : 1);

export interface RunAccessContext {
  version: PipelineVersion;
  settings: Pick<AgentSettings, "maxRevisions" | "minFit" | "panel"> & Partial<Pick<AgentSettings, "parallel" | "motivation">>;
  /** 지원처별 이력서인가(v2 지원 동기 구역). */
  company: boolean;
}

/** 두 계획 공통의 진행 상태(next는 배치 — v1은 0~1개). */
export type RunStateAny = Omit<RunStateV2, "next"> & { next: NextStep[] };

export function evaluateAny(rows: readonly StepRowLike[], ctx: RunAccessContext): RunStateAny {
  const base = { maxRevisions: ctx.settings.maxRevisions, minFit: ctx.settings.minFit, panel: ctx.settings.panel };
  if (ctx.version === 2) {
    return evaluateSectionRun(rows, { ...base, motivation: ctx.company && (ctx.settings.motivation ?? true), parallel: ctx.settings.parallel });
  }
  const s = evaluateRun(rows, base);
  return { ...s, next: s.next ? [s.next] : [] };
}

/** 작전: v1 plan, v2 brief(plan의 확장 — 그대로 plan 자리에 들어간다). */
export function planOf(rows: readonly StepRowLike[], version: PipelineVersion): ResumeAgentPlan | null {
  return version === 2 ? (parsedOutput(rows, "brief", 0)?.brief ?? null) : (parsedOutput(rows, "plan", 0)?.plan ?? null);
}

export function draftAt(rows: readonly StepRowLike[], version: PipelineVersion, k: number): AgentDraft | null {
  return version === 2 ? draftOfRoundV2(rows, k) : draftOfRound(rows, k);
}

export function packAt(rows: readonly StepRowLike[], version: PipelineVersion, k: number): EvidencePack | null {
  return version === 2 ? currentPackV2(rows, k) : currentPack(rows, k);
}

export function verifyAt(rows: readonly StepRowLike[], version: PipelineVersion, k: number): VerifyReport | null {
  if (version === 2) return verifyOfRoundV2(rows, k);
  return k === 0 ? (parsedOutput(rows, "write_top", 0)?.verify ?? null) : (parsedOutput(rows, "revise", k)?.verify ?? null);
}

export function latestRound(rows: readonly StepRowLike[], version: PipelineVersion): number | null {
  return version === 2 ? latestDraftRoundV2(rows) : latestDraftRound(rows);
}

/** 라운드 k의 미리 보기 텍스트. */
export function previewAt(rows: readonly StepRowLike[], version: PipelineVersion, k: number): string | null {
  if (version === 2) return parsedOutput(rows, "compose", k)?.previewText ?? null;
  return k === 0 ? (parsedOutput(rows, "write_top", 0)?.previewText ?? null) : (parsedOutput(rows, "revise", k)?.previewText ?? null);
}
