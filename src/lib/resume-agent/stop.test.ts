import { describe, expect, it } from "vitest";
import type { ReviewRound } from "./schemas";
import { chooseBestRound, decideStop, onlyUserGaps, panelScore, roundPassed } from "./stop";

const round = (over: Partial<ReviewRound> = {}): ReviewRound => ({
  round: 0,
  verdicts: [],
  passCount: 0,
  passTotal: 3,
  matchScore: 50,
  fitItems: [],
  atsKeywordsMissing: [],
  issues: [{ id: "i", reviewer: "manager", severity: "major", quote: null, quoteVerified: false, paths: [], issue: "x", requirementId: null, needsUserInfo: false }],
  panelScore: 30,
  atsPass: false,
  incomplete: false,
  failedReviewers: [],
  raw: {},
  ...over,
});
const ctx = { jdSource: "jd" as const, maxRevisions: 2, panel: "core" as const, overBudget: false };

describe("panelScore", () => {
  it("통과 판정은 심사위원 기준: 리더의 PASS는 거절, ATS의 PASS는 통과", () => {
    expect(panelScore([{ reviewer: "ats", verdict: "PASS" }, { reviewer: "manager", verdict: "PASS" }, { reviewer: "gatekeeper", verdict: "NO" }], 0, 3, 50)).toBe(40);
    expect(panelScore([{ reviewer: "ats", verdict: "PASS" }, { reviewer: "manager", verdict: "HIRE" }, { reviewer: "gatekeeper", verdict: "INTERVIEW" }], 0, 3, 100)).toBe(100);
  });
  it("실패한 심사위원은 중립(0.5)", () => {
    expect(panelScore([{ reviewer: "ats", verdict: "PASS" }], 2, 3, 0)).toBe(40);
  });
});

describe("decideStop", () => {
  it("passed: ATS 통과 + 핵심 2/3 + 적합도 75(공고 없이 추정이면 70)", () => {
    expect(decideStop([round({ atsPass: true, passCount: 2, matchScore: 75 })], ctx)).toEqual({ stop: true, reason: "passed" });
    expect(decideStop([round({ atsPass: false, passCount: 3, matchScore: 90 })], ctx).stop).toBe(false);
    expect(roundPassed(round({ atsPass: true, passCount: 2, matchScore: 72 }), { ...ctx, jdSource: "inferred" })).toBe(true);
    expect(roundPassed(round({ atsPass: true, passCount: 2, matchScore: 72 }), ctx)).toBe(false);
  });
  it("budget → max_rounds → plateau → only_user_gaps 순", () => {
    expect(decideStop([round()], { ...ctx, overBudget: true })).toEqual({ stop: true, reason: "budget" });
    expect(decideStop([round(), round({ round: 1, panelScore: 60 }), round({ round: 2, panelScore: 90 })], ctx)).toEqual({ stop: true, reason: "max_rounds" });
    expect(decideStop([round()], { ...ctx, maxRevisions: 0 })).toEqual({ stop: true, reason: "max_rounds" });
    expect(decideStop([round({ panelScore: 40 }), round({ round: 1, panelScore: 42 })], ctx)).toEqual({ stop: true, reason: "plateau" });
    expect(decideStop([round({ panelScore: 40 }), round({ round: 1, panelScore: 35 })], ctx)).toEqual({ stop: true, reason: "plateau" });
    expect(decideStop([round({ panelScore: 40 }), round({ round: 1, panelScore: 50 })], ctx).stop).toBe(false);
  });
  it("only_user_gaps는 round 0에도: 고칠 수 있는 critical·major가 없으면 수정하지 않는다", () => {
    const gapsOnly = round({ issues: [{ ...round().issues[0]!, needsUserInfo: true }, { ...round().issues[0]!, severity: "minor" }] });
    expect(onlyUserGaps(gapsOnly)).toBe(true);
    expect(decideStop([gapsOnly], ctx)).toEqual({ stop: true, reason: "only_user_gaps" });
  });
});

describe("chooseBestRound", () => {
  it("가장 높은 점수, 동점이면 나중 라운드", () => {
    expect(chooseBestRound([round({ panelScore: 50 }), round({ round: 1, panelScore: 70 }), round({ round: 2, panelScore: 60 })])).toBe(1);
    expect(chooseBestRound([round({ panelScore: 50 }), round({ round: 1, panelScore: 50 })])).toBe(1);
    expect(chooseBestRound([])).toBeNull();
  });
  it("ctx가 있으면 목표 통과 → ATS 통과 → 점수 순: ATS에서 떨어진 고득점 라운드보다 통과 라운드를 고른다", () => {
    // R0: ATS 탈락, 문지기·팀장 통과, 적합도 85 → 74점(미통과). R1: ATS·문지기 통과, 팀장 탈락, 적합도 75 → 70점(통과).
    const r0 = round({ round: 0, atsPass: false, passCount: 2, matchScore: 85, panelScore: 74 });
    const r1 = round({ round: 1, atsPass: true, passCount: 2, matchScore: 75, panelScore: 70 });
    expect(decideStop([r0, r1], ctx)).toEqual({ stop: true, reason: "passed" });
    expect(chooseBestRound([r0, r1])).toBe(0);
    expect(chooseBestRound([r0, r1], ctx)).toBe(1);
    // 둘 다 미통과면 ATS 통과 라운드가 먼저.
    const r2 = round({ round: 1, atsPass: true, passCount: 1, matchScore: 60, panelScore: 44 });
    expect(chooseBestRound([r0, r2], ctx)).toBe(1);
    // 같은 등급이면 점수, 동점이면 나중.
    expect(chooseBestRound([round({ panelScore: 50 }), round({ round: 1, panelScore: 50 })], ctx)).toBe(1);
  });
});
