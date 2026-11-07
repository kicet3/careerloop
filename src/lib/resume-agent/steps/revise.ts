/**
 * 단계 revise(라운드 k ≥ 1): expand(결정적 공백 재검색) → patch(LLM, task resume-agent-revise) → verify(결정적).
 * - expand: fit이 missing·partial로 본 요건과 ATS 누락 키워드마다 그래프를 다시 찾는다(loadAgentGraph — 작업 행 userId만).
 *   새 노드는 E{n+1}…로 더하고(기존 번호 유지), 아무것도 못 찾은 요건 지적은 needsUserInfo로 확정한다.
 * - patch: 경로 단위 op만 받아 applyPatch로 적용(잘못된 op만 버림). 유효한 op가 없으면 noop → 다음 심사 없이 plateau.
 */
import { compactKey } from "@/lib/skills/dictionary";
import { excludedRefs } from "../citations";
import { expandPack } from "../evidence";
import { currentPack, draftOfRound, parsedOutput } from "../next-step";
import { applyPatch } from "../patch";
import { buildRevisePrompt } from "../prompts";
import { LlmRevisePatchSchema, type EvidenceItem, type ReviseStepOutput, type VerifyReport } from "../schemas";
import { verifyDraft } from "../verify";
import { agentPromptContext, AgentStepError, previewText, UsageMeter, type StepContext, type StepResult } from "./shared";

const EMPTY_VERIFY: VerifyReport = { numbersFlagged: [], dropped: [], corrected: [], riskyClaims: [], retriedForCitations: false };

export async function runReviseStep(ctx: StepContext, k: number): Promise<StepResult<ReviseStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const plan = parsedOutput(ctx.rows, "plan", 0);
  const base = draftOfRound(ctx.rows, k - 1);
  const review = parsedOutput(ctx.rows, "review", k - 1);
  const pack0 = currentPack(ctx.rows, k - 1);
  if (!jd || !plan || !base || !review || !pack0) throw new AgentStepError("missing_input", "수정할 초안·심사 결과가 없습니다.", false);
  const meter = new UsageMeter();

  // expand
  const reqs = new Map([...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => [r.id, r]));
  const targets = [
    ...review.round.fitItems
      .filter((i) => i.status !== "met")
      .map((i) => ({ requirementId: i.requirementId, query: [reqs.get(i.requirementId)?.text ?? "", reqs.get(i.requirementId)?.jdQuote ?? ""].join(" ").trim() }))
      .filter((t) => t.query),
    ...review.round.atsKeywordsMissing.map((kw) => ({ requirementId: null, query: kw })),
  ];
  const graph = await ctx.loadGraph(ctx.job);
  const expanded = expandPack(graph, pack0, targets, { nowYear: ctx.nowYear });
  const pack = expanded.pack;
  const unresolved = new Set(expanded.unresolved);
  const issues = review.round.issues.map((i) => (i.requirementId && unresolved.has(i.requirementId) && i.reviewer === "fit" ? { ...i, needsUserInfo: true } : i));

  // 근거: 현재 인용 + 새로 찾은 노드 + 지적 요건의 근거 + 경력 뼈대.
  const cited = new Set(base.citations.flatMap((c) => c.refs));
  const issueReqs = new Set(issues.map((i) => i.requirementId).filter((x): x is string => !!x));
  for (const b of pack.byRequirement) if (issueReqs.has(b.requirementId)) b.refs.forEach((r) => cited.add(r));
  const newRefs = new Set(pack.items.slice(pack0.items.length).map((i) => i.ref));
  const kwKeys = review.round.atsKeywordsMissing.map(compactKey).filter((x) => x.length >= 2);
  const excluded = excludedRefs(plan.plan);
  const evidence: EvidenceItem[] = pack.items.filter(
    (i) =>
      !excluded.has(i.ref) &&
      (cited.has(i.ref) ||
      newRefs.has(i.ref) ||
      ["Company", "Role"].includes(i.label) ||
      kwKeys.some((kw) => compactKey(`${i.name} ${i.text} ${i.skills.join(" ")}`).includes(kw))),
  );

  // 이전 라운드 수정이 점수를 떨어뜨렸으면 그 요약을 되풀이 금지로 넘긴다.
  const regressed: string[] = [];
  if (k >= 2) {
    const before = parsedOutput(ctx.rows, "review", k - 2)?.round.panelScore;
    if (before !== undefined && review.round.panelScore < before) {
      const s = parsedOutput(ctx.rows, "revise", k - 1)?.summary;
      if (s) regressed.push(s);
    }
  }

  const { system, user } = buildRevisePrompt(agentPromptContext(ctx.job.input), jd.jd, base, evidence, plan.plan, { round: review.round, issues, regressed });
  const patch = meter.take(
    await ctx.llm.generate({ task: "resume-agent-revise", system, user, schema: LlmRevisePatchSchema, effort: "medium", maxTokens: 24_000, signal: ctx.signal, cacheUser: false }),
  );
  const applied = applyPatch(base, patch.ops, {
    packRefs: new Set(pack.items.map((i) => i.ref)),
    requirementIds: new Set(reqs.keys()),
    round: k,
    issues,
    excludedRefs: excluded,
  });
  const questions = patch.questions.filter((q) => q.requirementId === null || reqs.has(q.requirementId));
  const expand = { added: expanded.added, graphChanged: expanded.graphChanged, unresolved: [...unresolved] };
  const changedPack = expanded.added > 0 || expanded.graphChanged ? pack : null;

  if (applied.changes.length === 0) {
    return {
      output: { draft: base, pack: changedPack, verify: EMPTY_VERIFY, changes: [], rejectedOps: applied.rejected, questions, summary: patch.summary, expand, noop: true, previewText: previewText(base.document, ctx.job.input.templateId) },
      summary: ["고칠 수 있는 지적이 없어 수정을 멈춥니다", ...(applied.rejected.length ? [`받지 않은 수정 ${applied.rejected.length}개`] : [])],
      usage: meter.usage,
      model: meter.model,
    };
  }
  const verified = verifyDraft(applied.draft, pack, plan.plan, { allowRetry: false });
  const summary = [
    `바꾼 곳 ${applied.changes.length}개${applied.rejected.length ? ` · 받지 않은 수정 ${applied.rejected.length}개` : ""}`,
    `근거 추가 ${expanded.added}개 · 질문으로 넘김 ${questions.length + unresolved.size}개`,
  ];
  if (verified.report.numbersFlagged.length > 0) summary.push(`수치 확인 ${verified.report.numbersFlagged.length}건`);
  return {
    output: {
      draft: verified.draft,
      pack: changedPack,
      verify: verified.report,
      changes: applied.changes,
      rejectedOps: applied.rejected,
      questions,
      summary: patch.summary,
      expand,
      noop: false,
      previewText: previewText(verified.draft.document, ctx.job.input.templateId),
    },
    summary,
    usage: meter.usage,
    model: meter.model,
  };
}
