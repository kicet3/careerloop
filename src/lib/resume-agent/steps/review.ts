/**
 * 단계 review(라운드마다 핵심 4회: ats·gatekeeper·manager·fit)와 final_panel(최종본 1회: rival·ceo·recruiter·teammate).
 * 패널 코드는 복사하지 않고 runPanelStage(진단 파이프라인과 공유)를 부른다. 심사에 들어가는 것은 이 작업의 문서 텍스트와
 * 이 작업 r0.jd 행의 JD 분석뿐이다. 통과 판정은 isPositiveVerdict로만(리더의 PASS는 거절).
 * - review: ats와 fit은 반드시 성공해야 집계한다. 실패한 호출은 단계 안에서 1회 다시 보내고, 그래도 실패하면 성공한 출력을
 *   partial로 남겨 다음 시도가 다시 부르지 않게 한다. gatekeeper·manager 하나가 실패하면 중립(0.5)으로 계산하고 incomplete.
 * - final_panel: 실패한 독자는 "심사 못 함"(verdict null). 4명 모두 실패하면 단계 실패.
 */
import { isPositiveVerdict } from "@/lib/domain/reviewers";
import type { ReaderResult, ReviewerId, StageKey, StageOutputs } from "@/lib/domain/schemas";
import { runPanelStage } from "@/lib/panel/pipeline";
import { verifyQuote } from "@/lib/panel/quotes";
import { isDocPath, locateQuote } from "../citations";
import { currentPack, draftOfRound, evaluateRun, parsedOutput } from "../next-step";
import { ReviewPartialSchema, type AgentDraft, type EvidencePack, type FinalPanelStepOutput, type ResumeAgentPlan, type ReviewIssue, type ReviewRound, type ReviewStepOutput, type VerifyReport } from "../schemas";
import { CORE_REVIEWERS, FINAL_READERS, panelScore } from "../stop";
import { AgentStepError, panelInputFor, reviewText, UsageMeter, type StepContext, type StepResult } from "./shared";

type PanelKey = Extract<StageKey, ReviewerId | "fit">;
const FULL_REVIEWERS = ["ats", "gatekeeper", "manager", "rival", "ceo", "recruiter", "teammate"] as const satisfies readonly ReviewerId[];

async function runStages(
  ctx: StepContext,
  stages: readonly PanelKey[],
  resumeText: string,
  jd: StageOutputs["jd"],
  done: Record<string, unknown>,
  opts: { effort?: "low" | "medium" } = {},
): Promise<{ outputs: Record<string, unknown>; failed: PanelKey[]; meter: UsageMeter }> {
  const meter = new UsageMeter();
  const situation = parsedOutput(ctx.rows, "retrieve", 0)?.situation ?? "general";
  const input = panelInputFor(ctx.job.input, resumeText, situation);
  const outputs: Record<string, unknown> = { ...done };
  const runOnce = async (list: readonly PanelKey[]) => {
    const results = await Promise.allSettled(
      list.map((stage) => runPanelStage(stage, input, { jd }, ctx.llm, { signal: ctx.signal, usageTask: "resume-agent-review", cacheUser: false, effort: opts.effort })),
    );
    const failed: PanelKey[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") outputs[list[i]!] = meter.take(r.value);
      else failed.push(list[i]!);
    });
    return failed;
  };
  let failed = await runOnce(stages.filter((s) => outputs[s] == null));
  if (failed.length > 0 && !ctx.signal.aborted) failed = await runOnce(failed);
  return { outputs, failed, meter };
}

function severityOfReader(verdict: string, reviewer: ReviewerId): ReviewIssue["severity"] {
  return isPositiveVerdict(reviewer, verdict) ? "minor" : "major";
}

/** 심사 출력 → 지적 목록(quote 검증·문서 경로 역매핑·needsUserInfo 판정). */
export function collectIssues(
  round: number,
  outputs: Record<string, unknown>,
  doc: AgentDraft["document"],
  resumeText: string,
  jd: StageOutputs["jd"],
  pack: EvidencePack,
  plan: ResumeAgentPlan,
  verify: VerifyReport | null,
): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  let n = 0;
  const add = (reviewer: ReviewIssue["reviewer"], severity: ReviewIssue["severity"], quote: string | null, issue: string, requirementId: string | null = null, needsUserInfo = false) => {
    const verified = quote ? verifyQuote(resumeText, quote) : false;
    issues.push({
      id: `r${round}-${reviewer}-${++n}`,
      reviewer,
      severity,
      quote,
      quoteVerified: verified,
      paths: verified ? locateQuote(doc, quote) : [],
      issue: issue.slice(0, 500),
      requirementId,
      needsUserInfo,
    });
  };
  const ats = outputs.ats as StageOutputs["ats"] | undefined;
  if (ats) {
    const reject = !isPositiveVerdict("ats", ats.verdict);
    for (const r of ats.reasons) add("ats", reject ? "critical" : "minor", r.quote, r.issue);
    if (ats.keywordsMissing.length > 0) add("ats", reject ? "critical" : "major", null, `JD 키워드가 이력서에 없습니다: ${ats.keywordsMissing.join(", ")}`);
  }
  const gk = outputs.gatekeeper as StageOutputs["gatekeeper"] | undefined;
  if (gk) for (const w of gk.weakestLines) add("gatekeeper", isPositiveVerdict("gatekeeper", gk.verdict) ? "minor" : "major", w.quote, w.issue);
  for (const id of ["manager", "rival", "ceo", "recruiter", "teammate"] as const) {
    const r = outputs[id] as ReaderResult | undefined;
    if (!r) continue;
    add(id, severityOfReader(r.verdict, id), r.worstLine.quote, r.worstLine.issue);
    for (const p of r.otherProblems) add(id, "minor", null, p);
  }
  const fit = outputs.fit as StageOutputs["fit"] | undefined;
  if (fit) {
    const must = new Set(jd.mustHave.map((r) => r.id));
    const reqText = new Map([...jd.mustHave, ...jd.niceToHave].map((r) => [r.id, r.text]));
    const noEvidence = new Set(pack.byRequirement.filter((b) => b.refs.length === 0).map((b) => b.requirementId));
    const gap = new Set(plan.requirementMap.filter((r) => r.status === "gap").map((r) => r.requirementId));
    for (const item of fit.items) {
      if (item.status === "met") continue;
      const isMust = must.has(item.requirementId);
      const severity = item.status === "missing" ? (isMust ? "critical" : "major") : isMust ? "major" : "minor";
      const needsUser = item.status === "missing" && (noEvidence.has(item.requirementId) || gap.has(item.requirementId));
      add("fit", severity, item.evidenceQuote, `${reqText.get(item.requirementId) ?? item.requirementId} — ${item.note}`, item.requirementId, needsUser);
    }
  }
  for (const c of verify?.riskyClaims ?? []) {
    const id = `r${round}-verify-${++n}`;
    issues.push({
      id,
      reviewer: "verify",
      severity: "minor",
      quote: c.text,
      quoteVerified: true,
      paths: isDocPath(c.path) ? [c.path] : [],
      issue:
        c.reason === "gap_requirement"
          ? "근거가 없다고 본 요건을 충족한 것처럼 쓴 줄입니다. 근거 범위로 줄이거나 지우세요."
          : c.reason === "ownership"
            ? "근거에 없는 주도·리드 표현입니다. 근거에 있는 역할로 고치세요."
            : "근거에 없는 최상급 표현(최초·유일)입니다. 근거에 있는 사실로 고치세요.",
      requirementId: null,
      needsUserInfo: false,
    });
  }
  return issues.slice(0, 80);
}

function verifyOfRound(ctx: StepContext, k: number): VerifyReport | null {
  return k === 0 ? (parsedOutput(ctx.rows, "write_top", 0)?.verify ?? null) : (parsedOutput(ctx.rows, "revise", k)?.verify ?? null);
}

export async function runReviewStep(ctx: StepContext, k: number): Promise<StepResult<ReviewStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const plan = parsedOutput(ctx.rows, "plan", 0);
  const draft = draftOfRound(ctx.rows, k);
  const pack = currentPack(ctx.rows, k);
  if (!jd || !plan || !draft || !pack) throw new AgentStepError("missing_input", "심사할 초안이 없습니다.", false);
  const full = ctx.settings.panel === "full";
  const reviewers: readonly ReviewerId[] = full ? FULL_REVIEWERS : CORE_REVIEWERS;
  const stages: PanelKey[] = [...reviewers, "fit"];
  const text = reviewText(draft.document, ctx.job.input.templateId);
  const prev = ReviewPartialSchema.safeParse(ctx.previousOutput);
  const { outputs, failed, meter } = await runStages(ctx, stages, text, jd.jd, prev.success ? prev.data.partial : {});
  if (outputs.ats == null || outputs.fit == null) {
    throw new AgentStepError("review_incomplete", "서류 자동 필터·적합도 심사를 끝내지 못했습니다. 다시 시도합니다.", false, { partial: outputs }, meter.usage);
  }
  const verdicts = reviewers
    .filter((r) => outputs[r] != null)
    .map((reviewer) => {
      const o = outputs[reviewer] as { verdict: string; oneLiner: string };
      return { reviewer, verdict: o.verdict, positive: isPositiveVerdict(reviewer, o.verdict), oneLiner: o.oneLiner };
    });
  const fit = outputs.fit as StageOutputs["fit"];
  const ats = outputs.ats as StageOutputs["ats"];
  const failedReviewers = failed.filter((f) => f !== "fit" && f !== "ats");
  const round: ReviewRound = {
    round: k,
    verdicts,
    passCount: verdicts.filter((v) => v.positive).length,
    passTotal: reviewers.length,
    matchScore: fit.matchScore,
    fitItems: fit.items,
    atsKeywordsMissing: ats.keywordsMissing.slice(0, 40),
    issues: collectIssues(k, outputs, draft.document, text, jd.jd, pack, plan.plan, verifyOfRound(ctx, k)),
    panelScore: panelScore(verdicts, failedReviewers.length, reviewers.length, fit.matchScore),
    atsPass: isPositiveVerdict("ats", ats.verdict),
    incomplete: failedReviewers.length > 0,
    failedReviewers,
    raw: outputs,
  };
  const summary = [
    `${full ? "심사위원" : "핵심 심사"} ${round.passCount}/${round.passTotal} 통과 · 적합도 ${round.matchScore} · ATS ${round.atsPass ? "통과" : `탈락(키워드 누락 ${round.atsKeywordsMissing.length})`}`,
  ];
  if (round.incomplete) summary.push(`심사 못 한 심사위원: ${failedReviewers.length}명(중립으로 계산)`);
  return { output: { round }, summary, usage: meter.usage, model: meter.model };
}

export async function runFinalPanelStep(ctx: StepContext): Promise<StepResult<FinalPanelStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const state = evaluateRun(ctx.rows, { maxRevisions: ctx.settings.maxRevisions, minFit: ctx.settings.minFit, panel: ctx.settings.panel });
  const chosen = state.chosenRound;
  const draft = chosen === null ? null : draftOfRound(ctx.rows, chosen);
  if (!jd || !draft || chosen === null) throw new AgentStepError("missing_input", "최종 심사할 초안이 없습니다.", false);
  const round = state.rounds.find((r) => r.round === chosen)!;
  const have = new Set(round.verdicts.map((v) => v.reviewer));
  const readers = FINAL_READERS.filter((r) => !have.has(r));
  const text = reviewText(draft.document, ctx.job.input.templateId);
  const { outputs, failed, meter } = await runStages(ctx, readers, text, jd.jd, {}, { effort: ctx.settings.readerEffort === "medium" ? "medium" : "low" });
  if (readers.length > 0 && failed.length === readers.length) throw new AgentStepError("final_panel_failed", "최종 심사를 끝내지 못했습니다.", false, undefined, meter.usage);
  const verdicts = readers.map((reviewer) => {
    const o = outputs[reviewer] as ReaderResult | undefined;
    return o
      ? { reviewer, verdict: o.verdict, positive: isPositiveVerdict(reviewer, o.verdict), oneLiner: o.oneLiner }
      : { reviewer, verdict: null, positive: false, oneLiner: "심사 못 함" };
  });
  const pass = verdicts.filter((v) => v.positive).length + round.verdicts.filter((v) => v.positive).length;
  return { output: { verdicts }, summary: [`최종본 심사위원 7명 중 ${Math.min(7, pass)}명 통과`], usage: meter.usage, model: meter.model };
}
