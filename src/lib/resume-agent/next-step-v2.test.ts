import { describe, expect, it } from "vitest";
import { composeOut, critiqueOut, feedbackFor, headRows, reviewRound, round0Rows, row, secRow, WAVE1 } from "./__fixtures__/v2-rows";
import { parseStepKey, stepKey } from "./job-types";
import { currentPackV2, evaluateSectionRun, isFallbackAttempt, maxAttemptsFor, NEXT_ROUND_COST, sectionOutputAt, type RunContextV2 } from "./next-step-v2";

const ctx: RunContextV2 = { maxRevisions: 2, panel: "core", motivation: true, parallel: 4 };
const keys = (s: { next: { key: string }[] }) => s.next.map((n) => n.key);

describe("parseStepKey(v2)", () => {
  it("구역 키 r1.sec.experience → section, v1 키 회귀", () => {
    expect(parseStepKey("r1.sec.experience")).toEqual({ round: 1, kind: "section", section: "experience" });
    expect(parseStepKey("r0.sec.motivation_draft")).toEqual({ round: 0, kind: "section", section: "motivation_draft" });
    expect(parseStepKey("r0.sec.unknown")).toBeNull();
    expect(parseStepKey("r0.section")).toBeNull();
    expect(parseStepKey("r0.review")).toEqual({ round: 0, kind: "review" });
    expect(parseStepKey("r2.revise")).toEqual({ round: 2, kind: "revise" });
    expect(parseStepKey("r0.compose")).toEqual({ round: 0, kind: "compose" });
    expect(parseStepKey("final_panel")).toEqual({ round: -1, kind: "final_panel" });
    expect(stepKey("section", 1, "skills")).toBe("r1.sec.skills");
  });
});

describe("evaluateSectionRun", () => {
  it("jd → retrieve → brief는 하나씩, 그다음 웨이브 1 배치(4개), 웨이브 1이 다 끝나기 전엔 웨이브 2가 나오지 않는다", () => {
    expect(keys(evaluateSectionRun([], ctx))).toEqual(["r0.jd"]);
    expect(keys(evaluateSectionRun(headRows().slice(0, 2), ctx))).toEqual(["r0.brief"]);
    expect(keys(evaluateSectionRun(headRows(), ctx))).toEqual(WAVE1.map((s) => `r0.sec.${s}`));
    const partial = [...headRows(), secRow("experience", 0), secRow("projects", 0), secRow("extras", 0)];
    // 지원 동기(선택 구역)는 웨이브 2를 막지 않고 필수 배치에 얹힌다. 초안은 추천이 끝난 뒤.
    expect(keys(evaluateSectionRun(partial, ctx))).toEqual(["r0.sec.highlights", "r0.sec.skills", "r0.sec.motivation_suggest"]);
    const wave1 = [...headRows(), ...WAVE1.map((s) => secRow(s, 0))];
    expect(keys(evaluateSectionRun(wave1, ctx))).toEqual(["r0.sec.highlights", "r0.sec.skills", "r0.sec.motivation_draft"]);
  });

  it("병렬 상한(parallel)으로 배치를 자르고, 같은 배치에서 실패한 구역이 있어도 성공한 구역은 다시 실행하지 않는다", () => {
    expect(keys(evaluateSectionRun(headRows(), { ...ctx, parallel: 2 }))).toEqual(["r0.sec.experience", "r0.sec.projects"]);
    const rows = [...headRows(), secRow("experience", 0), secRow("projects", 0, "pending"), secRow("extras", 0)];
    expect(keys(evaluateSectionRun(rows, ctx))).toEqual(["r0.sec.projects", "r0.sec.motivation_suggest"]);
  });

  it("라운드 0 본문 구역이 실패로 닫히면 작업 실패, 지원 동기 구역 실패는 건너뛴다", () => {
    const fail = [...headRows(), secRow("experience", 0, "failed"), secRow("projects", 0), secRow("extras", 0), secRow("motivation_suggest", 0)];
    expect(evaluateSectionRun(fail, ctx).fail).toBe("r0.sec.experience");
    const motFail = [...headRows(), secRow("experience", 0), secRow("projects", 0), secRow("extras", 0), secRow("motivation_suggest", 0, "failed")];
    expect(keys(evaluateSectionRun(motFail, ctx))).toEqual(["r0.sec.highlights", "r0.sec.skills", "r0.sec.motivation_draft"]);
  });

  it("공용 이력서(motivation false)면 지원 동기 구역을 내지 않는다", () => {
    expect(keys(evaluateSectionRun(headRows(), { ...ctx, motivation: false }))).toEqual(["r0.sec.experience", "r0.sec.projects", "r0.sec.extras"]);
    const wave1 = [...headRows(), ...["experience", "projects", "extras"].map((s) => secRow(s as "experience", 0))];
    expect(keys(evaluateSectionRun(wave1, { ...ctx, motivation: false }))).toEqual(["r0.sec.highlights", "r0.sec.skills"]);
  });

  it("compose → review → critique → 피드백 받은 구역만 r1 배치 → compose → review", () => {
    const r0 = round0Rows();
    expect(keys(evaluateSectionRun(r0, ctx))).toEqual(["r0.review"]);
    const reviewed = [...r0, row("r0.review", { round: reviewRound(0) })];
    expect(keys(evaluateSectionRun(reviewed, ctx))).toEqual(["r0.critique"]);
    const critiqued = [...reviewed, row("r0.critique", critiqueOut(0, [feedbackFor("experience"), feedbackFor("skills")]))];
    // 재작성도 웨이브 순서(경력 → 직무 역량).
    expect(keys(evaluateSectionRun(critiqued, ctx))).toEqual(["r1.sec.experience"]);
    expect(keys(evaluateSectionRun([...critiqued, secRow("experience", 1)], ctx))).toEqual(["r1.sec.skills"]);
    // 한 구역이 실패로 닫혀도(이전 출력 사용) 나머지가 끝나면 compose로.
    const rewritten = [...critiqued, secRow("experience", 1), secRow("skills", 1, "failed")];
    expect(keys(evaluateSectionRun(rewritten, ctx))).toEqual(["r1.compose"]);
    expect(keys(evaluateSectionRun([...rewritten, row("r1.compose", composeOut(1))], ctx))).toEqual(["r1.review"]);
  });

  it("유지 구역은 조립 시 이전 라운드 출력을 쓴다(sectionOutputAt)", () => {
    const rows = [...round0Rows(), secRow("experience", 1, "done", { notes: ["r1"] })];
    expect(sectionOutputAt(rows, "experience", 1)?.round).toBe(1);
    expect(sectionOutputAt(rows, "skills", 1)?.round).toBe(0);
    expect(sectionOutputAt([...rows, secRow("skills", 1, "failed")], "skills", 1)?.round).toBe(0);
  });

  it("종료: passed·피드백 없음(plateau·only_user_gaps)·조각 그대로(plateau)·max_rounds·budget, 마지막 라운드 critique 생략", () => {
    const base = round0Rows();
    const passed = evaluateSectionRun([...base, row("r0.review", { round: reviewRound(0, { atsPass: true, passCount: 2, matchScore: 90 }) })], ctx);
    expect(passed.stopReason).toBe("passed");
    expect(keys(passed)).toEqual(["final_panel"]);

    const reviewed = [...base, row("r0.review", { round: reviewRound(0) })];
    expect(evaluateSectionRun([...reviewed, row("r0.critique", critiqueOut(0, []))], ctx).stopReason).toBe("plateau");
    const userGaps = [...base, row("r0.review", { round: reviewRound(0, { issues: [] }) }), row("r0.critique", critiqueOut(0, []))];
    expect(evaluateSectionRun(userGaps, ctx).stopReason).toBe("only_user_gaps");

    const same = [...reviewed, row("r0.critique", critiqueOut(0, [feedbackFor("experience")])), secRow("experience", 1, "done", { unchanged: true }), row("r1.compose", composeOut(1, { unchanged: true }))];
    const s = evaluateSectionRun(same, ctx);
    expect(s.stopReason).toBe("plateau");
    expect(keys(s)).toEqual(["final_panel"]);

    const max = evaluateSectionRun(reviewed, { ...ctx, maxRevisions: 0 });
    expect(max.stopReason).toBe("max_rounds");
    expect(keys(max)).toEqual(["final_panel"]);

    const budget = evaluateSectionRun(reviewed.map((r) => ({ ...r, usage: { inputTokens: 700_000, outputTokens: 0 } })), ctx);
    expect(budget.stopReason).toBe("budget");
    expect(budget.finalPanel).toBe("skipped");

    // 라운드 2(maxRevisions) review 뒤에는 critique를 돌리지 않는다.
    const r2 = [
      ...reviewed,
      row("r0.critique", critiqueOut(0, [feedbackFor("experience")])),
      secRow("experience", 1),
      row("r1.compose", composeOut(1)),
      row("r1.review", { round: reviewRound(1, { panelScore: 50 }) }),
      row("r1.critique", critiqueOut(1, [feedbackFor("projects")])),
      secRow("projects", 2),
      row("r2.compose", composeOut(2)),
      row("r2.review", { round: reviewRound(2, { panelScore: 60 }) }),
    ];
    const end = evaluateSectionRun(r2, ctx);
    expect(end.stopReason).toBe("max_rounds");
    // 고른 라운드(2)의 프로젝트가 초안(라운드 0)보다 새로우므로 지원 동기 초안을 그 본문으로 다시 쓴다(최종 심사와 함께).
    expect(keys(end)).toEqual(["final_panel", "r2.sec.motivation_draft"]);
    expect(keys(evaluateSectionRun(r2, { ...ctx, motivation: false }))).toEqual(["final_panel"]);
    const redrafted = [...r2, secRow("motivation_draft", 2), row("final_panel", { verdicts: [] }, "failed")];
    expect(keys(evaluateSectionRun(redrafted, ctx))).toEqual(["finalize"]);
    expect(end.rounds).toHaveLength(3);
  });

  it("최신 pack은 critique(k−1)부터 거슬러 찾고, 없으면 retrieve", () => {
    const rows = [...round0Rows(), row("r0.critique", critiqueOut(0, [], { pack: { version: 2, graphFingerprint: "g2", items: [], byRequirement: [], coverage: { mustFound: 0, mustTotal: 0, niceFound: 0, niceTotal: 0 }, truncated: false, skillKeys: [] } }))];
    expect(currentPackV2(rows, 0)?.version).toBe(1);
    expect(currentPackV2(rows, 1)?.version).toBe(2);
    expect(currentPackV2(rows, 2)?.version).toBe(2);
  });

  it("수상·기타 실패는 작업 실패가 아니다(비워 두고 웨이브 2로)", () => {
    const rows = [...headRows(), secRow("experience", 0), secRow("projects", 0), secRow("extras", 0, "failed"), secRow("motivation_suggest", 0)];
    const s = evaluateSectionRun(rows, ctx);
    expect(s.fail).toBeNull();
    expect(keys(s)).toEqual(["r0.sec.highlights", "r0.sec.skills", "r0.sec.motivation_draft"]);
  });

  it("지원 동기(선택 구역)는 막지 않는다: 남아 있으면 조립·심사 배치에 얹히고, 저장 전에는 따로 끝낸다", () => {
    const noDraft = [...headRows(), ...WAVE1.map((s) => secRow(s, 0)), secRow("highlights", 0), secRow("skills", 0), secRow("motivation_draft", 0, "pending")];
    expect(keys(evaluateSectionRun(noDraft, ctx))).toEqual(["r0.compose", "r0.sec.motivation_draft"]);
    expect(keys(evaluateSectionRun(noDraft, { ...ctx, parallel: 1 }))).toEqual(["r0.compose"]);
    const passed = [...noDraft, row("r0.compose", composeOut(0)), row("r0.review", { round: reviewRound(0, { atsPass: true, passCount: 2, matchScore: 90 }) }), row("final_panel", null, "failed")];
    expect(keys(evaluateSectionRun(passed, { ...ctx, parallel: 1 }))).toEqual(["r0.sec.motivation_draft"]);
    expect(maxAttemptsFor({ kind: "section", section: "motivation_draft" })).toBe(2);
    expect(maxAttemptsFor({ kind: "section", section: "experience" })).toBe(3);
    expect(isFallbackAttempt({ kind: "section", round: 0, section: "extras" }, 3)).toBe(true);
    expect(isFallbackAttempt({ kind: "section", round: 1, section: "extras" }, 3)).toBe(false);
    expect(isFallbackAttempt({ kind: "section", round: 0, section: "motivation_draft" }, 3)).toBe(false);
  });

  it("총괄이 지원 동기 초안에 피드백을 내면 재작성 라운드의 웨이브 2와 함께 초안을 다시 쓴다", () => {
    const reviewed = [...round0Rows(), row("r0.review", { round: reviewRound(0) })];
    const critiqued = [...reviewed, row("r0.critique", critiqueOut(0, [feedbackFor("experience"), feedbackFor("highlights")], { motivation: { instructions: ["JD와 잇는다"] } }))];
    expect(keys(evaluateSectionRun(critiqued, ctx))).toEqual(["r1.sec.experience"]);
    expect(keys(evaluateSectionRun([...critiqued, secRow("experience", 1)], ctx))).toEqual(["r1.sec.highlights", "r1.sec.motivation_draft"]);
    expect(keys(evaluateSectionRun([...critiqued, secRow("experience", 1)], { ...ctx, motivation: false }))).toEqual(["r1.sec.highlights"]);
  });

  it("예산: 다음 라운드 추정은 가장 큰 구역 4개 × 1.5 + 조립·심사·총괄, 라운드 도중 재시도로 예산을 넘으면 그 라운드를 버리고 끝낸다", () => {
    expect(NEXT_ROUND_COST).toBe(Math.round((18_000 + 18_000 + 10_000 + 10_000) * 1.5) + 14_000 + 50_000 + 20_000);
    const critiqued = [...round0Rows(), row("r0.review", { round: reviewRound(0) }), row("r0.critique", critiqueOut(0, [feedbackFor("experience")]))];
    expect(keys(evaluateSectionRun(critiqued, ctx))).toEqual(["r1.sec.experience"]);
    const heavy = [...critiqued, row("r1.sec.experience", null, "pending", { usage: { inputTokens: 600_000, outputTokens: 0 } })];
    const s = evaluateSectionRun(heavy, ctx);
    expect(s.stopReason).toBe("budget");
    expect(keys(s)).toEqual(["final_panel"]);
  });
});
