/**
 * 단계 write_body · write_top(task resume-agent-write). 한 번에 전체 문서를 쓰면 출력이 길어 단계 시간 상한을 넘을 수 있어 둘로 나눈다.
 * - write_body: 경력·프로젝트·학력·자격·기타 + 항목 인용. 인용 없는 줄이 25%를 넘으면 같은 단계에서 한 번 다시 쓴다.
 * - write_top: 헤드라인·요약·핵심 성과·기술 + 인용 → 본문과 합쳐 결정적 사실 검증(verifyDraft). 상단 칸의 인용이 25%를 넘게 빠지면 1회 재작성.
 * - 재작성 호출이 시간 상한·오류로 끝나지 못해도 첫 결과는 버리지 않는다(인용 없는 줄만 지우고 진행).
 */
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { usageOfError } from "@/lib/llm/types";
import { parseCitations } from "../citations";
import { parsedOutput } from "../next-step";
import { buildWriteBodyPrompt, buildWriteTopPrompt } from "../prompts";
import { LlmBodyDraftSchema, LlmTopDraftSchema, type AgentDraft, type WriteBodyStepOutput, type WriteTopStepOutput } from "../schemas";
import { draftIsEmpty, isTopPath, verifyDraft } from "../verify";
import { addUsage, agentPromptContext, AgentStepError, previewText, UsageMeter, type StepContext, type StepResult } from "./shared";

function inputs(ctx: StepContext) {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const ret = parsedOutput(ctx.rows, "retrieve", 0);
  const plan = parsedOutput(ctx.rows, "plan", 0);
  if (!jd || !ret || !plan) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const requirementIds = new Set([...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => r.id));
  return { jd: jd.jd, pack: ret.pack, plan: plan.plan, requirementIds, packRefs: new Set(ret.pack.items.map((i) => i.ref)) };
}

export async function runWriteBodyStep(ctx: StepContext): Promise<StepResult<WriteBodyStepOutput>> {
  const { jd, pack, plan, requirementIds, packRefs } = inputs(ctx);
  const meter = new UsageMeter();
  const write = async (retry: { uncited: string[] } | null): Promise<AgentDraft> => {
    const { system, user } = buildWriteBodyPrompt(agentPromptContext(ctx.job.input), jd, pack, plan, retry);
    const out = meter.take(
      await ctx.llm.generate({ task: "resume-agent-write", system, user, schema: LlmBodyDraftSchema, effort: "medium", maxTokens: 32_000, signal: ctx.signal, cacheUser: false }),
    );
    const document = { ...emptyResumeDocument(), experience: out.experience, projects: out.projects, education: out.education, certifications: out.certifications, extras: out.extras };
    const { citations } = parseCitations(out.citations, document, packRefs, requirementIds);
    return { document, citations, notes: out.notes.slice(0, 10), missingInfo: [] };
  };
  let draft = await write(null);
  let retried = false;
  let retryFailed = false;
  const check = verifyDraft(draft, pack, plan, { allowRetry: true });
  if (check.needsRetry) {
    retried = true;
    // 다시 쓰기가 시간 상한·오류로 끝나지 못하면 첫 초안을 버리지 않는다: 첫 초안으로 진행하고 인용 없는 줄은 write_top 검증이 지운다
    // (retriedForCitations = true → write_top은 본문 때문에 다시 쓰지 않는다).
    try {
      draft = await write({ uncited: check.uncitedPaths });
    } catch (err) {
      meter.usage = addUsage(meter.usage, usageOfError(err));
      if (draftIsEmpty(draft.document)) throw err;
      retryFailed = true;
    }
  }
  if (draftIsEmpty(draft.document)) throw new AgentStepError("draft_empty", "경력·프로젝트를 하나도 쓰지 못했습니다. 다시 시도합니다.", false, undefined, meter.usage);
  const summary = [`경력 ${draft.document.experience.length}개 · 프로젝트 ${draft.document.projects.length}개 · 인용 ${draft.citations.length}개`];
  if (retryFailed) summary.push("인용이 빠진 줄이 많아 다시 쓰려 했지만 시간 안에 끝나지 않아 첫 초안으로 진행합니다(인용 없는 줄은 빠집니다)");
  else if (retried) summary.push("인용이 빠진 줄이 많아 한 번 다시 썼습니다");
  return { output: { draft, retriedForCitations: retried }, summary, usage: meter.usage, model: meter.model };
}

export async function runWriteTopStep(ctx: StepContext): Promise<StepResult<WriteTopStepOutput>> {
  const { jd, pack, plan, requirementIds, packRefs } = inputs(ctx);
  const body = parsedOutput(ctx.rows, "write_body", 0);
  if (!body) throw new AgentStepError("missing_input", "본문 초안이 없습니다.", false);
  const meter = new UsageMeter();
  const write = async (retry: { uncited: string[] } | null): Promise<{ draft: AgentDraft; invalidRefPaths: string[] }> => {
    const { system, user } = buildWriteTopPrompt(agentPromptContext(ctx.job.input), jd, pack, plan, body.draft, retry);
    const out = meter.take(
      await ctx.llm.generate({ task: "resume-agent-write", system, user, schema: LlmTopDraftSchema, effort: "low", maxTokens: 16_000, signal: ctx.signal, cacheUser: false }),
    );
    const document = structuredClone(body.draft.document);
    document.basics.headline = (plan.headline || out.basics.headline).slice(0, 160);
    document.basics.tagline = out.basics.tagline;
    document.basics.totalExperience = out.basics.totalExperience;
    document.summary = out.summary;
    document.highlights = out.highlights;
    document.skills = out.skills;
    const top = parseCitations(out.citations, document, packRefs, requirementIds);
    const citations = [...body.draft.citations.filter((c) => !top.citations.some((t) => t.path === c.path)), ...top.citations];
    const missingInfo = [...out.missingInfo, ...plan.gapQuestions.map((g) => g.question)];
    return { draft: { document, citations, notes: body.draft.notes, missingInfo: [...new Set(missingInfo)].slice(0, 30) }, invalidRefPaths: top.invalidRefPaths };
  };
  const first = await write(null);
  // 재작성 판정은 상단 칸만 센다(본문 공백은 write_body가 이미 다뤘고, 상단 작성기는 본문 경로를 고칠 수 없다).
  let verified = verifyDraft(first.draft, pack, plan, { allowRetry: true, retryScope: isTopPath, invalidRefPaths: first.invalidRefPaths });
  if (verified.needsRetry) {
    let second: Awaited<ReturnType<typeof write>> | null = null;
    try {
      second = await write({ uncited: verified.uncitedPaths });
    } catch (err) {
      // 다시 쓰기가 시간 상한·오류로 끝나지 못하면 첫 상단으로 마무리한다(인용 없는 줄은 지운다).
      meter.usage = addUsage(meter.usage, usageOfError(err));
      second = null;
    }
    const use = second ?? first;
    verified = verifyDraft(use.draft, pack, plan, { allowRetry: false, retried: true, invalidRefPaths: use.invalidRefPaths });
  }
  const report = { ...verified.report, retriedForCitations: verified.report.retriedForCitations || body.retriedForCitations };
  if (draftIsEmpty(verified.draft.document)) throw new AgentStepError("draft_empty", "근거가 있는 경력·프로젝트가 남지 않았습니다. 다시 시도합니다.", false, undefined, meter.usage);
  const summary = [
    `사실 검증: 수치 확인 ${report.numbersFlagged.length}건 · 근거 없는 줄 ${report.dropped.filter((d) => d.reason !== "unknown_skill").length}개 제외 · 고침 ${report.corrected.length}건`,
  ];
  if (report.riskyClaims.length > 0) summary.push(`근거 확인이 필요한 표현 ${report.riskyClaims.length}건(심사·수정 단계로 넘김)`);
  return {
    output: { draft: verified.draft, verify: report, previewText: previewText(verified.draft.document, ctx.job.input.templateId) },
    summary,
    usage: meter.usage,
    model: meter.model,
  };
}
