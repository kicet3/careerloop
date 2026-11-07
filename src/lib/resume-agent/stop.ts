/**
 * 심사 점수·종료 판정·최종 라운드 선택(순수, 결정적 — 시각을 입력으로 받지 않는다). 각 review 뒤에 평가한다.
 * 통과 판정은 반드시 isPositiveVerdict(심사위원, 판정)로만 한다 — 리더 5명의 PASS는 거절이다.
 */
import { isPositiveVerdict } from "@/lib/domain/reviewers";
import type { ReviewerId } from "@/lib/domain/schemas";
import type { ReviewRound, StopReason } from "./schemas";

export const STOP_RULES = {
  atsMustPass: true,
  /** 핵심 3명(ats·gatekeeper·manager) 중 통과 수. */
  minCorePass: 2,
  minMatchScore: 75,
  minMatchScoreInferred: 70,
  maxRevisions: 2,
  minGain: 3,
  /** RESUME_AGENT_PANEL=full이면 7명 중. */
  minPassFull: 5,
} as const;

export const CORE_REVIEWERS = ["ats", "gatekeeper", "manager"] as const satisfies readonly ReviewerId[];
export const FINAL_READERS = ["rival", "ceo", "recruiter", "teammate"] as const satisfies readonly ReviewerId[];

/**
 * 라운드 점수(0~100) = round(0.6·통과 비율·100 + 0.4·적합도). 실패한 심사위원은 중립(0.5)으로 센다.
 * verdicts: 성공한 심사위원 판정, failed: 실패한 심사위원 수, total: 분모(핵심 3, full 7).
 */
export function panelScore(verdicts: readonly { reviewer: ReviewerId; verdict: string }[], failed: number, total: number, matchScore: number): number {
  const pass = verdicts.filter((v) => isPositiveVerdict(v.reviewer, v.verdict)).length + 0.5 * failed;
  return Math.round(0.6 * (pass / Math.max(1, total)) * 100 + 0.4 * matchScore);
}

export interface StopContext {
  jdSource: "jd" | "inferred";
  maxRevisions: number;
  minFit?: number;
  panel: "core" | "full";
  /** 다음 수정 라운드를 시작하면 작업 토큰 예산을 넘는다. */
  overBudget: boolean;
}

export function targetFit(ctx: Pick<StopContext, "jdSource" | "minFit">): number {
  const base = ctx.minFit ?? STOP_RULES.minMatchScore;
  return ctx.jdSource === "inferred" ? Math.min(base, STOP_RULES.minMatchScoreInferred) : base;
}

/** 이 라운드가 목표를 넘었는가(ATS 통과 + 핵심 2/3(full이면 5/7) + 적합도). */
export function roundPassed(r: ReviewRound, ctx: Pick<StopContext, "jdSource" | "minFit" | "panel">): boolean {
  const minPass = ctx.panel === "full" ? STOP_RULES.minPassFull : STOP_RULES.minCorePass;
  return (!STOP_RULES.atsMustPass || r.atsPass) && r.passCount >= minPass && r.matchScore >= targetFit(ctx);
}

/** 고칠 수 있는 critical·major 지적이 없다(남은 것은 모두 사용자 정보가 필요). */
export function onlyUserGaps(r: ReviewRound): boolean {
  return r.issues.filter((i) => i.severity !== "minor" && !i.needsUserInfo).length === 0;
}

export type StopDecision = { stop: false } | { stop: true; reason: StopReason };

/**
 * rounds: 지금까지의 review 결과(0..k). k번째 review 뒤에 더 수정할지.
 * 순서: passed → budget → max_rounds → plateau(직전 라운드보다 개선 < minGain 또는 하락) → only_user_gaps.
 */
export function decideStop(rounds: readonly ReviewRound[], ctx: StopContext): StopDecision {
  const last = rounds.at(-1);
  if (!last) return { stop: false };
  if (roundPassed(last, ctx)) return { stop: true, reason: "passed" };
  if (ctx.overBudget) return { stop: true, reason: "budget" };
  if (rounds.length - 1 >= Math.min(ctx.maxRevisions, STOP_RULES.maxRevisions)) return { stop: true, reason: "max_rounds" };
  if (rounds.length >= 2) {
    const prev = rounds.at(-2)!;
    if (last.panelScore - prev.panelScore < STOP_RULES.minGain) return { stop: true, reason: "plateau" };
  }
  if (onlyUserGaps(last)) return { stop: true, reason: "only_user_gaps" };
  return { stop: false };
}

/**
 * 최종본 라운드. ctx가 있으면 사전식 순위: 목표 통과(roundPassed) → ATS 통과 → panelScore → 나중 라운드.
 * (panelScore만 보면 ATS에서 떨어진 라운드가 통과한 라운드보다 높을 수 있다 — stopReason 'passed'와 최종본이 어긋난다.)
 * ctx가 없으면 panelScore → 나중 라운드. 라운드가 없으면 null.
 */
export function chooseBestRound(rounds: readonly ReviewRound[], ctx?: Pick<StopContext, "jdSource" | "minFit" | "panel">): number | null {
  const key = (r: ReviewRound): number[] => (ctx ? [roundPassed(r, ctx) ? 1 : 0, r.atsPass ? 1 : 0, r.panelScore] : [r.panelScore]);
  const better = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
    return true; // 동점이면 나중 라운드
  };
  let best: ReviewRound | null = null;
  for (const r of rounds) if (!best || better(key(r), key(best))) best = r;
  return best ? best.round : null;
}
