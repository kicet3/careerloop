import { describe, expect, it } from "vitest";
import { evaluateRun, type StepRowLike } from "./next-step";
import type { ReviewRound } from "./schemas";
import { draft, exp, pack } from "./__fixtures__/units";

const jd = { jd: { source: "jd", roleTitle: "r", company: null, seniority: "", summary: "", mustHave: [], niceToHave: [], keywords: [], responsibilities: [], hiddenSignals: [] }, signals: [] };
const d = draft({ experience: [exp()] });
const verify = { numbersFlagged: [], dropped: [], corrected: [], riskyClaims: [], retriedForCitations: false };
const plan = { plan: { positioning: "", headline: "", requirementMap: [], include: { experience: [], projects: [], extras: [] }, exclude: [], keywordPlan: [], sectionEmphasis: [], gapQuestions: [] }, warnings: [] };
const reviewOut = (k: number, score: number, pass = false): unknown => ({
  round: { round: k, verdicts: [], passCount: pass ? 3 : 0, passTotal: 3, matchScore: pass ? 90 : 40, fitItems: [], atsKeywordsMissing: [], issues: [{ id: "i", reviewer: "manager", severity: "major", quote: null, quoteVerified: false, paths: [], issue: "x", requirementId: null, needsUserInfo: false }], panelScore: score, atsPass: pass, incomplete: false, failedReviewers: [], raw: {} } satisfies ReviewRound,
});
const reviseOut = (noop = false): unknown => ({ draft: d, pack: null, verify, changes: [], rejectedOps: [], questions: [], summary: "", expand: { added: 0, graphChanged: false, unresolved: [] }, noop, previewText: "" });
const done = (key: string, output: unknown, usage?: unknown): StepRowLike => ({ key, kind: key.split(".").at(-1)!, round: 0, status: "done", output, attempt: 1, usage });
const base = (): StepRowLike[] => [
  done("r0.jd", jd),
  done("r0.retrieve", { pack: pack([]), warnings: [], situation: "general" }),
  done("r0.plan", plan),
  done("r0.write_body", { draft: d, retriedForCitations: false }),
  done("r0.write_top", { draft: d, verify, previewText: "" }),
];
const ctx = { maxRevisions: 2, panel: "core" as const };

describe("evaluateRun", () => {
  it("round 0 단계를 순서대로, 끝난 단계는 건너뛴다(재개)", () => {
    expect(evaluateRun([], ctx).next?.key).toBe("r0.jd");
    expect(evaluateRun(base().slice(0, 2), ctx).next?.key).toBe("r0.plan");
    expect(evaluateRun(base(), ctx).next?.key).toBe("r0.review");
  });

  it("출력이 스키마를 통과하지 못하는 done 행(배포 사이 변경)은 다시 실행한다", () => {
    const rows = base();
    rows[2] = done("r0.plan", { broken: true });
    expect(evaluateRun(rows, ctx).next?.key).toBe("r0.plan");
  });

  it("round 0 단계가 failed면 작업 실패", () => {
    const rows = [...base().slice(0, 2), { key: "r0.plan", kind: "plan", round: 0, status: "failed", output: null, attempt: 3 }];
    expect(evaluateRun(rows, ctx)).toMatchObject({ fail: "r0.plan", next: null });
  });

  it("심사 → 수정 → 재심사 → 통과하면 final_panel → finalize", () => {
    const rows = [...base(), done("r0.review", reviewOut(0, 20))];
    expect(evaluateRun(rows, ctx).next?.key).toBe("r1.revise");
    rows.push(done("r1.revise", reviseOut()));
    expect(evaluateRun(rows, ctx).next?.key).toBe("r1.review");
    rows.push(done("r1.review", reviewOut(1, 90, true)));
    const s = evaluateRun(rows, ctx);
    expect(s).toMatchObject({ next: { key: "final_panel" }, stopReason: "passed", chosenRound: 1 });
    rows.push(done("final_panel", { verdicts: [] }));
    expect(evaluateRun(rows, ctx).next?.key).toBe("finalize");
    rows.push(done("finalize", { resumeId: "x", stopReason: "passed" }));
    expect(evaluateRun(rows, ctx).next).toBeNull();
  });

  it("수정 op 0개(noop)면 심사 없이 plateau로 마무리", () => {
    const rows = [...base(), done("r0.review", reviewOut(0, 20)), done("r1.revise", reviseOut(true))];
    expect(evaluateRun(rows, ctx)).toMatchObject({ next: { key: "final_panel" }, stopReason: "plateau" });
  });

  it("심사·수정이 failed면 review_failed로 최선 초안 마무리, final_panel 실패는 건너뛴다", () => {
    const failed = (key: string): StepRowLike => ({ key, kind: "review", round: 0, status: "failed", output: null, attempt: 3 });
    expect(evaluateRun([...base(), failed("r0.review")], ctx)).toMatchObject({ stopReason: "review_failed", next: { key: "finalize" }, finalPanel: "skipped" });
    const rows = [...base(), done("r0.review", reviewOut(0, 20)), failed("r1.revise")];
    expect(evaluateRun(rows, ctx)).toMatchObject({ stopReason: "review_failed", next: { key: "final_panel" } });
    expect(evaluateRun([...rows, failed("final_panel")], ctx)).toMatchObject({ next: { key: "finalize" }, finalPanel: "failed" });
  });

  it("예산: 남은 토큰으로 다음 수정을 못 하면 budget, 최종 심사도 건너뛴다", () => {
    const rows = [...base(), done("r0.review", reviewOut(0, 20), { inputTokens: 480_000, outputTokens: 0 })];
    expect(evaluateRun(rows, ctx)).toMatchObject({ stopReason: "budget", next: { key: "finalize" }, finalPanel: "skipped" });
  });
});
