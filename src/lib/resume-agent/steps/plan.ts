/**
 * 단계 plan(task resume-agent-plan): 요건마다 근거 ref를 골라 strong | partial | gap으로 판정하고 포지셔닝·포함/제외·키워드 계획을 세운다.
 * 결정적 검증: pack 밖 ref·JD에 없는 요건 id는 버리고, 빠진 필수 요건은 gap으로 채우고, 기술 대조가 missing·claimed면 strong을 partial로 내린다.
 */
import { excludedRefs } from "../citations";
import { parsedOutput } from "../next-step";
import { buildPlanPrompt } from "../prompts";
import { LlmPlanSchema, type PlanStepOutput, type ResumeAgentPlan } from "../schemas";
import type { z } from "zod";
import { agentPromptContext, AgentStepError, UsageMeter, type StepContext, type StepResult } from "./shared";

export function sanitizePlan(raw: z.infer<typeof LlmPlanSchema>, ctx: { packRefs: ReadonlySet<string>; requirementIds: readonly string[]; mustIds: readonly string[]; skillStatus: ReadonlyMap<string, string> }): { plan: ResumeAgentPlan; warnings: string[] } {
  const ref = (r: string) => r.trim().replace(/^\[|\]$/g, "");
  const okRef = (r: string) => ctx.packRefs.has(ref(r));
  const reqSet = new Set(ctx.requirementIds);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const requirementMap: ResumeAgentPlan["requirementMap"] = [];
  for (const r of raw.requirementMap) {
    if (!reqSet.has(r.requirementId) || seen.has(r.requirementId)) continue;
    seen.add(r.requirementId);
    const refs = [...new Set(r.refs.filter(okRef).map(ref))].slice(0, 6);
    let status = refs.length === 0 ? "gap" : r.status;
    const skill = ctx.skillStatus.get(r.requirementId);
    if (status === "strong" && (skill === "missing" || skill === "claimed")) status = "partial";
    requirementMap.push({ requirementId: r.requirementId, status, refs, angle: r.angle });
  }
  for (const id of ctx.requirementIds) {
    if (seen.has(id)) continue;
    requirementMap.push({ requirementId: id, status: "gap", refs: [], angle: "" });
    if (ctx.mustIds.includes(id)) warnings.push(`필수 요건 ${id}를 전략에서 빠뜨려 공백으로 채웠습니다.`);
  }
  const plan: ResumeAgentPlan = {
    positioning: raw.positioning,
    headline: raw.headline,
    requirementMap,
    include: {
      experience: raw.include.experience.filter((e) => okRef(e.ref)).map((e) => ({ ...e, ref: ref(e.ref) })),
      projects: raw.include.projects.filter((p) => okRef(p.ref)).map((p) => ({ ...p, ref: ref(p.ref), requirementIds: p.requirementIds.filter((x) => reqSet.has(x)) })),
      extras: raw.include.extras.filter((p) => okRef(p.ref)).map((p) => ({ ...p, ref: ref(p.ref) })),
    },
    exclude: raw.exclude.filter((p) => okRef(p.ref)).map((p) => ({ ...p, ref: ref(p.ref) })),
    keywordPlan: raw.keywordPlan.filter((k) => okRef(k.ref)).map((k) => ({ ...k, ref: ref(k.ref) })),
    sectionEmphasis: raw.sectionEmphasis,
    gapQuestions: raw.gapQuestions.filter((g) => reqSet.has(g.requirementId)),
  };
  // 넣기로도 하고 빼기로도 한 ref는 넣는 쪽이 이긴다(제외 목록에서 지운다). 같은 ref의 제외가 여럿이면 하나만.
  const excluded = excludedRefs(plan);
  const seenExcluded = new Set<string>();
  plan.exclude = plan.exclude.filter((e) => excluded.has(e.ref) && !seenExcluded.has(e.ref) && !!seenExcluded.add(e.ref));
  return { plan, warnings };
}

export async function runPlanStep(ctx: StepContext): Promise<StepResult<PlanStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const ret = parsedOutput(ctx.rows, "retrieve", 0);
  if (!jd || !ret) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const meter = new UsageMeter();
  const { system, user } = buildPlanPrompt(agentPromptContext(ctx.job.input), jd.jd, ret.pack);
  const raw = meter.take(
    await ctx.llm.generate({ task: "resume-agent-plan", system, user, schema: LlmPlanSchema, effort: "medium", maxTokens: 24_000, signal: ctx.signal, cacheUser: false }),
  );
  const { plan, warnings } = sanitizePlan(raw, {
    packRefs: new Set(ret.pack.items.map((i) => i.ref)),
    requirementIds: [...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => r.id),
    mustIds: jd.jd.mustHave.map((r) => r.id),
    skillStatus: new Map(ret.pack.byRequirement.map((b) => [b.requirementId, b.skillStatus])),
  });
  const count = (s: string) => plan.requirementMap.filter((r) => r.status === s).length;
  const summary = [
    plan.positioning ? `포지셔닝: "${plan.positioning.slice(0, 80)}"` : "",
    `요건 근거: 충분 ${count("strong")} · 부분 ${count("partial")} · 공백 ${count("gap")}`,
    `프로젝트 ${plan.include.projects.length}개 선택, ${plan.exclude.length}개 제외`,
    ...warnings,
  ].filter(Boolean);
  return { output: { plan, warnings }, summary, usage: meter.usage, model: meter.model };
}
