/**
 * 단계 brief(v2 총괄 작전, task resume-agent-brief): v1 plan(요건별 근거 매핑·포지셔닝·포함/제외)에 구역 배정·근거 소유·분량 예산을 더한다.
 * 결정적 검증(sanitizeBrief): pack 밖 ref 버림, 요건 id 검증, 주 책임 중복 제거(같은 요건이 두 구역 primary면 그 요건 근거를 가장 많이
 * 가진 구역에 남기고 나머지는 secondary로), 소유가 없는 근거는 라벨로 배정, 분량은 표 값의 1.3배 상한·0.5배 하한, 합계가
 * PAGE_CHARS × pageTarget × 1.05를 넘으면 비례 축소. 첫 시도가 실패하면 두 번째 시도부터 축소 모드(배정·소유를 LLM에 받지 않는다).
 */
import { SECTION_LABELS, WRITING_SECTIONS, type WritingSection } from "../job-types";
import { parsedOutput } from "../next-step";
import { buildPlanPrompt, type AgentPromptContext } from "../prompts";
import { buildBriefPrompt } from "../prompts-v2";
import {
  LlmPlanSchema,
  LlmSectionBriefSchema,
  type BriefStepOutput,
  type EvidencePack,
  type LlmSectionBrief,
  type ResumeAgentPlan,
  type SectionAssignment,
  type SectionBrief,
  type SectionBudget,
} from "../schemas";
import { ownerForLabel } from "../sections/common";
import { sanitizePlan } from "./plan";
import { agentPromptContext, AgentStepError, UsageMeter, type StepContext, type StepResult } from "./shared";

/** A4 1쪽 본문 글자(현재 템플릿 resumeToText 기준 추정 — 실측 후 조정). */
export const PAGE_CHARS = 1900;
export const SUMMARY_CHARS: Record<1 | 2, number> = { 1: 200, 2: 250 };

/** 구역별 기본 분량(설계 문서 §2.3 표). */
export const DEFAULT_BUDGETS: Record<1 | 2, Record<WritingSection, SectionBudget>> = {
  1: {
    highlights: { items: 3, linesPerItem: 1, chars: 280 },
    experience: { items: 4, linesPerItem: 4, chars: 700 },
    projects: { items: 2, linesPerItem: 4, chars: 500 },
    skills: { items: 4, linesPerItem: 8, chars: 180 },
    extras: { items: 6, linesPerItem: 3, chars: 200 },
  },
  2: {
    highlights: { items: 4, linesPerItem: 1, chars: 400 },
    experience: { items: 6, linesPerItem: 5, chars: 1500 },
    projects: { items: 4, linesPerItem: 5, chars: 1100 },
    skills: { items: 6, linesPerItem: 8, chars: 250 },
    extras: { items: 8, linesPerItem: 4, chars: 300 },
  },
};

export { ownerForLabel };

const ymIndex = (s: string): number | null => {
  const m = /(\d{4})(?:\D(\d{1,2}))?/.exec(s);
  return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
};

/** 기본 쪽수: 직무 경력 3년 이상이거나 프로젝트 근거 5개 이상이면 2쪽. */
export function defaultPageTarget(pack: EvidencePack, asOf: Date = new Date()): 1 | 2 {
  const now = asOf.getFullYear() * 12 + asOf.getMonth();
  let earliest: number | null = null;
  for (const i of pack.items) {
    if (i.label !== "Role" || !i.facts) continue;
    const s = ymIndex(i.facts.startDate);
    if (s !== null && (earliest === null || s < earliest)) earliest = s;
  }
  const months = earliest === null ? 0 : now - earliest;
  const projects = pack.items.filter((i) => i.label === "Project").length;
  return months >= 36 || projects >= 5 ? 2 : 1;
}

/** 분량 상한·하한 강제와 합계 비례 축소. */
export function clampBudgets(
  raw: Partial<Record<WritingSection, SectionBudget | undefined>>,
  pageTarget: 1 | 2,
): Record<WritingSection, SectionBudget> {
  const table = DEFAULT_BUDGETS[pageTarget];
  const out = {} as Record<WritingSection, SectionBudget>;
  for (const s of WRITING_SECTIONS) {
    const t = table[s];
    const r = raw[s];
    const pick = (v: number | undefined, base: number) => (v === undefined || !Number.isFinite(v) || v > base * 1.3 || v < Math.floor(base * 0.5) ? base : Math.round(v));
    out[s] = r ? { items: pick(r.items, t.items), linesPerItem: pick(r.linesPerItem, t.linesPerItem), chars: pick(r.chars, t.chars) } : { ...t };
  }
  const total = WRITING_SECTIONS.reduce((n, s) => n + out[s].chars, 0) + SUMMARY_CHARS[pageTarget];
  const cap = PAGE_CHARS * pageTarget * 1.05;
  if (total > cap) {
    const f = (cap - SUMMARY_CHARS[pageTarget]) / (total - SUMMARY_CHARS[pageTarget]);
    for (const s of WRITING_SECTIONS) out[s] = { ...out[s], chars: Math.max(50, Math.floor(out[s].chars * f)) };
  }
  return out;
}

interface SanitizeCtx {
  pack: EvidencePack;
  requirementIds: readonly string[];
  mustIds: readonly string[];
  /** 지원처별 이력서(지원 동기 각도를 둔다). */
  company: boolean;
  asOf?: Date;
}

/** 결정적 구역 배정(축소 모드·LLM이 빠뜨린 구역). */
export function deterministicAssignment(section: WritingSection, plan: ResumeAgentPlan, pack: EvidencePack, owner: ReadonlyMap<string, WritingSection>, budget: SectionBudget): SectionAssignment {
  const items = new Map(pack.items.map((i) => [i.ref, i]));
  const refs = new Set<string>();
  for (const [ref, s] of owner) if (s === section) refs.add(ref);
  if (section === "highlights") {
    for (const i of pack.items) if (i.hasMetric && (i.label === "Achievement" || i.label === "Project")) refs.add(i.ref);
  }
  if (section === "skills") for (const p of plan.include.projects) refs.add(p.ref);
  const primary: string[] = [];
  const secondary: string[] = [];
  for (const r of plan.requirementMap) {
    if (r.status === "gap" || r.refs.length === 0) continue;
    const counts = new Map<WritingSection, number>();
    for (const ref of r.refs) {
      const s = owner.get(ref) ?? (items.get(ref) ? ownerForLabel(items.get(ref)!.label) : null);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let best: WritingSection | null = null;
    for (const s of WRITING_SECTIONS) if ((counts.get(s) ?? 0) > 0 && (best === null || counts.get(s)! > counts.get(best)!)) best = s;
    if (best === section) primary.push(r.requirementId);
    else if (r.refs.some((ref) => refs.has(ref))) secondary.push(r.requirementId);
  }
  const keywords = plan.keywordPlan.filter((k) => sectionOfKeywordPlan(k.section) === section || owner.get(k.ref) === section).map((k) => k.keyword);
  return {
    section,
    primaryRequirementIds: primary.slice(0, 20),
    secondaryRequirementIds: secondary.slice(0, 20),
    refs: [...refs].filter((r) => items.has(r)).slice(0, 30),
    angle: "",
    keywords: [...new Set(keywords)].slice(0, 15),
    budget,
  };
}

/** keywordPlan.section(자유 문자열)을 구역으로. */
function sectionOfKeywordPlan(s: string): WritingSection | null {
  const t = s.toLowerCase();
  if (/experience|경력/.test(t)) return "experience";
  if (/project|프로젝트/.test(t)) return "projects";
  if (/highlight|핵심|성과/.test(t)) return "highlights";
  if (/skill|기술|역량/.test(t)) return "skills";
  if (/extra|기타|수상|학력|자격/.test(t)) return "extras";
  return null;
}

export function sanitizeBrief(raw: LlmSectionBrief | null, plan: ResumeAgentPlan, ctx: SanitizeCtx): { brief: SectionBrief; warnings: string[] } {
  const warnings: string[] = [];
  const ref = (r: string) => r.trim().replace(/^\[|\]$/g, "");
  const items = new Map(ctx.pack.items.map((i) => [i.ref, i]));
  const okRef = (r: string) => items.has(ref(r));
  const reqSet = new Set(ctx.requirementIds);
  const excluded = new Set(plan.exclude.map((e) => e.ref));
  const pageTarget: 1 | 2 = raw?.pageTarget === 1 || raw?.pageTarget === 2 ? raw.pageTarget : defaultPageTarget(ctx.pack, ctx.asOf);

  // 근거 소유: LLM 값(pack 안·중복 없음) → 쓰기로 한 근거·요건 근거는 라벨로 결정적 배정.
  const owner = new Map<string, WritingSection>();
  for (const o of raw?.evidenceOwner ?? []) {
    const r = ref(o.ref);
    if (okRef(r) && !owner.has(r) && !excluded.has(r)) owner.set(r, o.section);
  }
  const used = new Set<string>([
    ...plan.include.experience.map((e) => e.ref),
    ...plan.include.projects.map((p) => p.ref),
    ...plan.include.extras.map((p) => p.ref),
    ...plan.requirementMap.flatMap((r) => r.refs),
    ...plan.keywordPlan.map((k) => k.ref),
  ]);
  for (const i of ctx.pack.items) {
    if (excluded.has(i.ref) && !used.has(i.ref)) continue;
    if (!owner.has(i.ref) && (used.has(i.ref) || ["Role", "Company", "Education", "Certification"].includes(i.label))) owner.set(i.ref, ownerForLabel(i.label));
  }
  // highlights·skills는 상세 서술 구역이 아니다(소유하지 않는다 — Skill 노드만 skills 소유로 둔다).
  for (const [r, s] of owner) if (s === "highlights" || (s === "skills" && items.get(r)!.label !== "Skill")) owner.set(r, ownerForLabel(items.get(r)!.label));
  // 작전이 '이 구역에 쓴다'고 정한 근거는 그 구역 소유로 덮어쓴다(지시서와 근거 범위가 어긋나 이름만 받는 일이 없게).
  for (const e of plan.include.experience) if (items.has(e.ref)) owner.set(e.ref, "experience");
  for (const e of plan.include.extras) if (items.has(e.ref)) owner.set(e.ref, "extras");
  for (const p of plan.include.projects) if (items.has(p.ref)) owner.set(p.ref, "projects");

  const rawBudgets: Partial<Record<WritingSection, SectionBudget>> = {};
  for (const a of raw?.assignments ?? []) if (!rawBudgets[a.section]) rawBudgets[a.section] = a.budget;
  const budgets = clampBudgets(rawBudgets, pageTarget);

  // 서술 구역(경력·프로젝트·기타)의 refs는 그 구역 소유이거나 소유가 없는 근거만(같은 근거를 두 구역이 상세히 쓰지 않게).
  // 핵심 성과·직무 역량은 다른 구역 근거를 한 줄 요약·이름으로 쓰므로 그대로 둔다.
  const narrative = (s: WritingSection) => s === "experience" || s === "projects" || s === "extras";
  const allowedFor = (s: WritingSection) => (r: string) => !narrative(s) || !owner.has(r) || owner.get(r) === s;
  const assignments: SectionAssignment[] = WRITING_SECTIONS.map((s) => {
    const a = raw?.assignments.find((x) => x.section === s);
    const det = deterministicAssignment(s, plan, ctx.pack, owner, budgets[s]);
    if (!a) return det;
    return {
      section: s,
      primaryRequirementIds: [...new Set(a.primaryRequirementIds.filter((r) => reqSet.has(r)))].slice(0, 20),
      secondaryRequirementIds: [...new Set(a.secondaryRequirementIds.filter((r) => reqSet.has(r)))].slice(0, 20),
      refs: [...new Set([...a.refs.filter(okRef).map(ref), ...det.refs])].filter((r) => (!excluded.has(r) || used.has(r)) && allowedFor(s)(r)).slice(0, 30),
      angle: a.angle,
      keywords: [...new Set(a.keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 15),
      budget: budgets[s],
    };
  });
  if (raw && raw.assignments.length < WRITING_SECTIONS.length) warnings.push("작전에서 빠진 구역은 근거 종류로 배정했습니다.");

  // 주 책임 중복 제거: 그 요건의 근거(requirementMap.refs)를 가장 많이 가진 구역에 남긴다.
  const reqRefs = new Map(plan.requirementMap.map((r) => [r.requirementId, new Set(r.refs)]));
  for (const id of ctx.requirementIds) {
    const holders = assignments.filter((a) => a.primaryRequirementIds.includes(id));
    if (holders.length <= 1) continue;
    const refsOf = reqRefs.get(id) ?? new Set<string>();
    const score = (a: SectionAssignment) => [...refsOf].filter((r) => a.refs.includes(r) || owner.get(r) === a.section).length;
    const keep = holders.reduce((b, a) => (score(a) > score(b) ? a : b));
    for (const a of holders) {
      if (a === keep) continue;
      a.primaryRequirementIds = a.primaryRequirementIds.filter((x) => x !== id);
      if (!a.secondaryRequirementIds.includes(id)) a.secondaryRequirementIds.push(id);
    }
  }
  // 근거가 있는 필수 요건이 어느 구역의 주 책임도 아니면 결정적 배정으로 채운다.
  for (const id of ctx.mustIds) {
    if (assignments.some((a) => a.primaryRequirementIds.includes(id))) continue;
    const det = WRITING_SECTIONS.map((s) => deterministicAssignment(s, plan, ctx.pack, owner, budgets[s])).find((a) => a.primaryRequirementIds.includes(id));
    if (det) assignments.find((a) => a.section === det.section)!.primaryRequirementIds.push(id);
  }

  // 작전이 고르지 않은 나머지 근거(뺀 근거 제외)도 라벨로 소유를 정한다: 구역 에이전트가 '참고 근거'로 전체 줄을 받는다
  // (배정 refs가 아니므로 지시서의 주 근거와 구분된다 — sectionEvidence).
  for (const i of ctx.pack.items) if (!owner.has(i.ref) && !excluded.has(i.ref)) owner.set(i.ref, ownerForLabel(i.label));

  const motivation = ctx.company
    ? {
        companyAngle: (raw?.motivation?.companyAngle || plan.positioning).slice(0, 200),
        linkRefs: [...new Set([...(raw?.motivation?.linkRefs ?? []).filter(okRef).map(ref), ...plan.include.projects.map((p) => p.ref)])].slice(0, 3),
      }
    : null;
  const brief: SectionBrief = {
    ...plan,
    pageTarget,
    assignments,
    evidenceOwner: [...owner].map(([r, section]) => ({ ref: r, section })).slice(0, 160),
    motivation,
    summaryAngle: (raw?.summaryAngle || plan.positioning).slice(0, 200),
    degraded: raw === null,
    summaryChars: SUMMARY_CHARS[pageTarget],
  };
  return { brief, warnings };
}

export async function runBriefStep(ctx: StepContext): Promise<StepResult<BriefStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const ret = parsedOutput(ctx.rows, "retrieve", 0);
  if (!jd || !ret) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const meter = new UsageMeter();
  const pctx: AgentPromptContext = agentPromptContext(ctx.job.input);
  const company = ctx.job.input.kind === "company";
  const degraded = (ctx.attempt ?? 1) >= 2;
  const pageTarget = defaultPageTarget(ret.pack);
  let raw: LlmSectionBrief | null = null;
  let planRaw: Parameters<typeof sanitizePlan>[0];
  if (!degraded) {
    const { system, user } = buildBriefPrompt(pctx, jd.jd, ret.pack, { pageTarget, budgets: DEFAULT_BUDGETS[pageTarget], company });
    raw = meter.take(
      await ctx.llm.generate({ task: "resume-agent-brief", system, user, schema: LlmSectionBriefSchema, effort: "medium", maxTokens: 24_000, signal: ctx.signal, cacheUser: false }),
    );
    planRaw = raw;
  } else {
    // 축소 모드: v1 전략 프롬프트로 요건 매핑만 받고, 배정·소유·분량은 결정적으로.
    const { system, user } = buildPlanPrompt(pctx, jd.jd, ret.pack);
    planRaw = meter.take(
      await ctx.llm.generate({ task: "resume-agent-brief", system, user, schema: LlmPlanSchema, effort: "medium", maxTokens: 16_000, signal: ctx.signal, cacheUser: false }),
    );
  }
  const requirementIds = [...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => r.id);
  const mustIds = jd.jd.mustHave.map((r) => r.id);
  const { plan, warnings: planWarnings } = sanitizePlan(planRaw, {
    packRefs: new Set(ret.pack.items.map((i) => i.ref)),
    requirementIds,
    mustIds,
    skillStatus: new Map(ret.pack.byRequirement.map((b) => [b.requirementId, b.skillStatus])),
  });
  const { brief, warnings } = sanitizeBrief(raw, plan, { pack: ret.pack, requirementIds, mustIds, company });
  const count = (s: string) => plan.requirementMap.filter((r) => r.status === s).length;
  const summary = [
    plan.positioning ? `포지셔닝: "${plan.positioning.slice(0, 80)}"` : "",
    `요건 근거: 충분 ${count("strong")} · 부분 ${count("partial")} · 공백 ${count("gap")}`,
    `구역 배정: ${brief.assignments.filter((a) => a.primaryRequirementIds.length > 0).map((a) => `${SECTION_LABELS[a.section]} ${a.primaryRequirementIds.length}`).join(" · ") || "없음"} · 목표 ${brief.pageTarget}쪽`,
    ...(brief.degraded ? ["축소 모드: 구역 배정을 근거 종류로 정했습니다"] : []),
    ...planWarnings,
    ...warnings,
  ].filter(Boolean);
  return { output: { brief, warnings: [...planWarnings, ...warnings].slice(0, 10) }, summary: summary.slice(0, 8), usage: meter.usage, model: meter.model };
}
