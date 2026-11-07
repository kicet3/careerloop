/**
 * 파이프라인 v2(구역별 에이전트 + 총괄) 다음 단계 계산(순수, docs/RESUME-SECTION-AGENTS.md §1·§4.5·§5.1).
 * 저장된 단계 행만으로 결정한다 — 어느 호출이 이어받아도 같은 답. next는 배치(같은 웨이브·라운드에서 함께 실행할 구역 단계들,
 * 또는 단일 단계 1개)다.
 *   round 0: jd → retrieve → brief → 웨이브 1(experience·projects·extras) → 웨이브 2(highlights·skills) → compose → review
 *   round k: (종료 판정) → critique(k−1) → 지시받은 구역만 r{k}.sec.*(웨이브 순서) → compose → review   (k = 1..maxRevisions)
 *   끝: (고른 라운드 본문이 새로우면 지원 동기 초안 다시 쓰기) + final_panel(예산이 남을 때) → finalize
 * - 지원 동기 두 구역(motivation_suggest·motivation_draft)은 선택 구역: 다음 웨이브·단계를 막지 않고 필수 배치의 남는 병렬 자리에
 *   얹혀 돌고, 남으면 finalize 전에 따로 끝낸다. 초안은 추천이 끝난 뒤. 총괄이 초안에 피드백을 내면 재작성 라운드의 웨이브 2와 함께.
 * - 출력이 스키마를 통과하지 못하는 done 행은 다시 실행할 단계로 본다(v1과 같다).
 * - 'failed' 구역 행: 라운드 0 필수 구역(경력·프로젝트·핵심 성과·직무 역량)이면 작업 실패(마지막 시도는 v1 작성기로 대체한 뒤다),
 *   수상·기타는 비워 두고 진행, 지원 동기 구역은 건너뛴다, 라운드 ≥ 1이면 이전 라운드 출력을 그대로 쓴다.
 */
import { SECTION_WAVES, sectionStepKey, stepKey, WRITING_SECTIONS, type SectionId, type WritingSection } from "./job-types";
import { MAX_STEP_ATTEMPTS, parsedOutput, STEP_TOKEN_ESTIMATE, usedTokens, type NextStep, type RunContext, type StepRowLike } from "./next-step";
import {
  SectionStepOutputSchema,
  type AgentDraft,
  type ComposeStepOutput,
  type CritiqueStepOutput,
  type EvidencePack,
  type ReviewRound,
  type SectionStepOutput,
  type StopReason,
  type VerifyReport,
} from "./schemas";
import { chooseBestRound, decideStop, onlyUserGaps } from "./stop";

/** 작업당 토큰 상한(v2). */
export const AGENT_JOB_TOKEN_BUDGET_V2 = 700_000;
/** 한 라운드에 다시 쓸 구역 상한(점수 낮은 순). */
export const MAX_SECTIONS_PER_ROUND = 4;
/** 병렬 구역 상한(RESUME_AGENT_PARALLEL 1~4). */
export const MAX_PARALLEL_SECTIONS = 4;

/** 구역 단계 소요 추정·상한(초)과 토큰 추정. */
export const SECTION_ESTIMATE_SEC: Record<SectionId, number> = {
  experience: 150,
  projects: 120,
  extras: 60,
  highlights: 60,
  skills: 45,
  motivation_draft: 60,
  motivation_suggest: 60,
};
export const SECTION_CAP_SEC: Record<SectionId, number> = {
  experience: 230,
  projects: 230,
  extras: 150,
  highlights: 150,
  skills: 120,
  motivation_draft: 120,
  motivation_suggest: 120,
};
export const SECTION_TOKEN_ESTIMATE: Record<SectionId, number> = {
  experience: 18_000,
  projects: 18_000,
  extras: 10_000,
  highlights: 10_000,
  skills: 10_000,
  motivation_draft: 10_000,
  motivation_suggest: 10_000,
};

/** 라운드 0에서 실패하면 작업이 실패하는 구역. 수상·기타(extras)와 지원 동기 구역은 빠진다(실패하면 비워 두고 진행). */
export const REQUIRED_SECTIONS: readonly SectionId[] = ["experience", "projects", "highlights", "skills"];
export const isMotivationSection = (s: SectionId): boolean => s === "motivation_draft" || s === "motivation_suggest";
/** 지원 동기 구역의 시도 상한(선택 구역 — 오래 붙잡지 않는다). */
export const MOTIVATION_MAX_ATTEMPTS = 2;
/** 단계의 시도 상한(지원 동기 구역은 MOTIVATION_MAX_ATTEMPTS, 그 밖은 MAX_STEP_ATTEMPTS). */
export const maxAttemptsFor = (n: { kind: string; section?: SectionId | null }): number =>
  n.kind === "section" && n.section && isMotivationSection(n.section) ? MOTIVATION_MAX_ATTEMPTS : MAX_STEP_ATTEMPTS;
/** 이 구역 단계 시도가 라운드 0의 마지막 시도(v1 작성기 대체)인가 — jobs.ts가 시간 상한을 v1 단계 값으로 바꾼다. */
export const isFallbackAttempt = (n: { kind: string; round: number; section?: SectionId | null }, attempt: number): boolean =>
  n.kind === "section" && n.round === 0 && !!n.section && !isMotivationSection(n.section) && attempt >= MAX_STEP_ATTEMPTS;
/** 웨이브 2(다른 구역 본문을 읽는) 구역인가. */
export const isWave2 = (s: SectionId): boolean => SECTION_WAVES[1]!.includes(s);

/** 다음 재작성 라운드 비용 추정: 가장 큰 구역 MAX_SECTIONS_PER_ROUND개 × 1.5(같은 단계 재작성) + compose·review·critique. */
export const NEXT_ROUND_COST =
  Math.round(
    (Object.entries(SECTION_TOKEN_ESTIMATE) as [SectionId, number][])
      .filter(([s]) => !isMotivationSection(s))
      .map(([, n]) => n)
      .sort((a, b) => b - a)
      .slice(0, MAX_SECTIONS_PER_ROUND)
      .reduce((a, b) => a + b, 0) * 1.5,
  ) +
  STEP_TOKEN_ESTIMATE.compose +
  STEP_TOKEN_ESTIMATE.review +
  STEP_TOKEN_ESTIMATE.critique;

export interface RunContextV2 extends RunContext {
  /** 지원처별 이력서이고 RESUME_AGENT_MOTIVATION이 켜져 있다(지원 동기 두 에이전트를 돌린다). */
  motivation: boolean;
  /** 한 배치의 구역 단계 수(1~4). */
  parallel?: number;
}

export interface RunStateV2 {
  /** 실행할 단계(배치). 비었으면 끝(finalize까지 done) 또는 fail. */
  next: NextStep[];
  fail: string | null;
  rounds: ReviewRound[];
  stopReason: StopReason | null;
  chosenRound: number | null;
  usedTokens: number;
  finalPanel: "pending" | "done" | "failed" | "skipped";
}

const rowOf = (rows: readonly StepRowLike[], key: string) => rows.find((r) => r.key === key);

/** 구역 단계 행 출력(정확히 그 라운드, done이고 스키마 통과). */
export function sectionOutput(rows: readonly StepRowLike[], section: SectionId, round: number): SectionStepOutput | null {
  const row = rowOf(rows, sectionStepKey(section, round));
  if (!row || row.status !== "done") return null;
  const parsed = SectionStepOutputSchema.safeParse(row.output);
  return parsed.success && !parsed.data.skipped ? parsed.data : null;
}

/** 라운드 k 이하의 가장 최근 done 구역 출력(조립·재작성의 '이전 조각'). */
export function sectionOutputAt(rows: readonly StepRowLike[], section: SectionId, k: number): { output: SectionStepOutput; round: number } | null {
  for (let j = Math.min(k, 2); j >= 0; j--) {
    const out = sectionOutput(rows, section, j);
    if (out) return { output: out, round: j };
  }
  return null;
}

export const composeOf = (rows: readonly StepRowLike[], k: number): ComposeStepOutput | null => parsedOutput(rows, "compose", k);
export const critiqueOf = (rows: readonly StepRowLike[], k: number): CritiqueStepOutput | null => parsedOutput(rows, "critique", k);

/** 라운드 k의 문서(compose k). */
export function draftOfRoundV2(rows: readonly StepRowLike[], k: number): AgentDraft | null {
  return composeOf(rows, k)?.draft ?? null;
}

export function verifyOfRoundV2(rows: readonly StepRowLike[], k: number): VerifyReport | null {
  return composeOf(rows, k)?.verify ?? null;
}

/** 라운드 k를 쓸 때의 pack: critique(k−1)…critique(0) 중 새 pack이 있는 가장 최근 것, 없으면 retrieve. */
export function currentPackV2(rows: readonly StepRowLike[], k = 3): EvidencePack | null {
  for (let j = Math.min(k, 3) - 1; j >= 0; j--) {
    const p = critiqueOf(rows, j)?.pack;
    if (p) return p;
  }
  return parsedOutput(rows, "retrieve", 0)?.pack ?? null;
}

export function latestDraftRoundV2(rows: readonly StepRowLike[]): number | null {
  for (let k = 2; k >= 0; k--) if (draftOfRoundV2(rows, k)) return k;
  return null;
}

/** 라운드 k에서 다시 쓰는 구역(critique k−1의 feedback). 라운드 0은 전부. */
export function sectionsForRound(rows: readonly StepRowLike[], k: number): WritingSection[] {
  if (k === 0) return [...WRITING_SECTIONS];
  return (critiqueOf(rows, k - 1)?.feedback ?? []).map((f) => f.section);
}

export function evaluateSectionRun(rows: readonly StepRowLike[], ctx: RunContextV2): RunStateV2 {
  const budget = ctx.tokenBudget ?? AGENT_JOB_TOKEN_BUDGET_V2;
  const used = usedTokens(rows);
  const parallel = Math.max(1, Math.min(ctx.parallel ?? MAX_PARALLEL_SECTIONS, MAX_PARALLEL_SECTIONS));
  const failed = (key: string) => rowOf(rows, key)?.status === "failed";
  const state: RunStateV2 = { next: [], fail: null, rounds: [], stopReason: null, chosenRound: null, usedTokens: used, finalPanel: "pending" };
  const at = (kind: NextStep["kind"], round: number): NextStep => ({ key: stepKey(kind, round), kind, round });
  const sec = (section: SectionId, round: number): NextStep => ({ key: sectionStepKey(section, round), kind: "section", round, section });
  /** 구역 단계가 끝났다(done이고 스키마 통과 — 건너뜀 출력 포함 — 또는 failed). */
  const settled = (s: SectionId, k: number) => {
    const r = rowOf(rows, sectionStepKey(s, k));
    return !!r && (r.status === "failed" || (r.status === "done" && SectionStepOutputSchema.safeParse(r.output).success));
  };
  // 선택 구역(지원 동기): 다음 웨이브·단계를 막지 않고 필수 배치에 얹어 실행한다(남으면 finalize 전에 따로).
  const optional: NextStep[] = [];
  const withOptional = (main: NextStep[]): NextStep[] => {
    const secs = main.filter((n) => n.kind === "section").length;
    const room = main.some((n) => n.kind !== "section") ? parallel - 1 : parallel - secs;
    return [...main, ...optional.filter((o) => !main.some((m) => m.key === o.key)).slice(0, Math.max(0, room))];
  };

  for (const kind of ["jd", "retrieve", "brief"] as const) {
    if (parsedOutput(rows, kind, 0)) continue;
    if (failed(stepKey(kind, 0))) return { ...state, fail: stepKey(kind, 0) };
    return { ...state, next: [at(kind, 0)] };
  }
  const jd = parsedOutput(rows, "jd", 0)!;
  const pickCtx = { jdSource: jd.jd.source, minFit: ctx.minFit, panel: ctx.panel };

  // 라운드 0 웨이브: 웨이브 1 본문 구역이 모두 끝나야(성공·수상/기타 실패) 웨이브 2가 나온다. 지원 동기 구역은 기다리지 않는다.
  for (const wave of SECTION_WAVES) {
    const pending: NextStep[] = [];
    for (const s of wave) {
      if (isMotivationSection(s)) {
        if (!ctx.motivation || settled(s, 0)) continue;
        // 초안은 추천(재료)이 끝난 뒤에(추천이 실패하면 재료 없이).
        if (s === "motivation_draft" && !settled("motivation_suggest", 0)) continue;
        optional.push(sec(s, 0));
        continue;
      }
      if (sectionOutput(rows, s, 0)) continue;
      const key = sectionStepKey(s, 0);
      if (failed(key)) {
        if (!REQUIRED_SECTIONS.includes(s)) continue; // 수상·기타는 비워 두고 진행
        return { ...state, fail: key };
      }
      pending.push(sec(s, 0));
    }
    if (pending.length > 0) return { ...state, next: withOptional(pending.slice(0, parallel)) };
  }
  if (!composeOf(rows, 0)) {
    if (failed(stepKey("compose", 0))) return { ...state, fail: stepKey("compose", 0) };
    return { ...state, next: withOptional([at("compose", 0)]) };
  }

  const motivationDraftRound = (k: number) => sectionOutputAt(rows, "motivation_draft", k);
  for (let k = 0; k <= 2; k++) {
    const review = parsedOutput(rows, "review", k);
    if (!review) {
      if (failed(stepKey("review", k))) {
        state.stopReason = "review_failed";
        break;
      }
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: withOptional([at("review", k)]) };
    }
    state.rounds.push(review.round);
    const decision = decideStop(state.rounds, { jdSource: jd.jd.source, maxRevisions: ctx.maxRevisions, minFit: ctx.minFit, panel: ctx.panel, overBudget: used + NEXT_ROUND_COST > budget });
    if (decision.stop) {
      state.stopReason = decision.reason;
      break;
    }
    const critique = critiqueOf(rows, k);
    if (!critique) {
      if (failed(stepKey("critique", k))) {
        state.stopReason = "plateau";
        break;
      }
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: withOptional([at("critique", k)]) };
    }
    // 고칠 구역도 상단 지시도 없다: 남은 지적이 사용자 정보뿐이면 only_user_gaps, 아니면 plateau.
    if (critique.feedback.length === 0 && critique.composeFeedback.length === 0) {
      state.stopReason = onlyUserGaps(review.round) ? "only_user_gaps" : "plateau";
      break;
    }
    // 재작성은 웨이브 순서로: 경력·프로젝트·기타가 끝난 뒤 핵심 성과·직무 역량(새 본문을 보고 중복을 피한다).
    // 실패한 구역은 이전 라운드 출력을 쓴다. 예산은 위 종료 판정이 매번 지금까지 쓴 토큰으로 다시 본다 — 라운드 도중 재시도로
    // 예산(다음 라운드 추정만큼 남김)을 넘으면 그 라운드를 버리고 끝낸 라운드 중에서 고른다(하드 상한).
    const todo = critique.feedback.map((f) => f.section).filter((s) => !settled(s, k + 1));
    const first = todo.filter((s) => !isWave2(s));
    if (first.length > 0) {
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: withOptional(first.slice(0, parallel).map((s) => sec(s, k + 1))) };
    }
    // 총괄이 지원 동기 초안에 피드백을 냈으면 웨이브 2와 함께 다시 쓴다(선택 구역).
    if (ctx.motivation && (critique.motivation?.instructions.length ?? 0) > 0 && motivationDraftRound(k) && !settled("motivation_draft", k + 1)) {
      optional.push(sec("motivation_draft", k + 1));
    }
    const second = todo.filter((s) => isWave2(s));
    if (second.length > 0) {
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: withOptional(second.slice(0, parallel).map((s) => sec(s, k + 1))) };
    }
    const compose = composeOf(rows, k + 1);
    if (!compose) {
      if (failed(stepKey("compose", k + 1))) {
        state.stopReason = "review_failed";
        break;
      }
      state.chosenRound = chooseBestRound(state.rounds, pickCtx);
      return { ...state, next: withOptional([at("compose", k + 1)]) };
    }
    if (compose.unchanged) {
      state.stopReason = "plateau";
      break;
    }
  }
  state.stopReason ??= "max_rounds";
  state.chosenRound = chooseBestRound(state.rounds, pickCtx);

  // 고른 라운드의 경력·프로젝트가 지원 동기 초안을 쓸 때보다 새로우면 그 본문으로 초안을 다시 쓴다(사라진 줄을 언급하지 않게).
  const c = state.chosenRound;
  if (ctx.motivation && c !== null && c > 0) {
    const m = motivationDraftRound(c);
    const bodyRound = Math.max(sectionOutputAt(rows, "experience", c)?.round ?? 0, sectionOutputAt(rows, "projects", c)?.round ?? 0);
    if (m && m.round < bodyRound && !settled("motivation_draft", c) && !optional.some((o) => o.key === sectionStepKey("motivation_draft", c))) {
      optional.push(sec("motivation_draft", c));
    }
  }

  if (parsedOutput(rows, "final_panel", -1)) state.finalPanel = "done";
  else if (failed("final_panel")) state.finalPanel = "failed";
  else if (state.rounds.length === 0 || used + STEP_TOKEN_ESTIMATE.final_panel > budget || rows.some((r) => r.key === "final_panel" && r.status === "skipped")) {
    state.finalPanel = "skipped";
  } else return { ...state, next: withOptional([at("final_panel", -1)]) };

  // 남은 선택 구역은 저장 전에 끝낸다(지원 동기 초안을 칸에 넣으므로).
  if (optional.length > 0 && !parsedOutput(rows, "finalize", -1)) return { ...state, next: optional.slice(0, parallel) };
  if (parsedOutput(rows, "finalize", -1)) return state;
  if (failed("finalize")) return { ...state, fail: "finalize" };
  return { ...state, next: [at("finalize", -1)] };
}
