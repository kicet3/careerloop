/**
 * 단계 section(v2 구역 에이전트, 키 r{k}.sec.{section}) — docs/RESUME-SECTION-AGENTS.md §3.
 * 본문 구역(경력·대표 프로젝트·핵심 성과·직무 역량·수상·기타): 공통 입력(저장된 JD 분석 + 이 구역 근거 + 총괄 지시서)으로 이 구역 조각만 쓴다.
 * 후처리(결정적): parseCitations → 이 구역 경로가 아닌 인용 버림 → 구역 범위 사실 검증(verifyDraft — 인용 없는 줄 25% 넘으면 같은 단계에서
 * 1회 재작성, 시간 부족이면 첫 결과로 진행) → 구역별 정리(핵심 성과 본문 복사 제거, 기타 묶음 정리·경로 재배치) → keepPaths 복원 →
 * 분량 자르기(주 책임 요건 줄은 마지막까지) → 이전 조각과 줄 단위 비교(바뀐 점).
 * 라운드 0의 마지막 시도는 v1 작성기(write_body·write_top 프롬프트)로 대체한다(§6.2).
 * 지원 동기 구역 두 개는 src/lib/resumes/motivation.ts의 에이전트를 부른다(추천 버튼과 같은 모듈).
 */
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { usageOfError, type GenerateResult } from "@/lib/llm/types";
import { runMotivationSuggest, writeMotivationDraft } from "@/lib/resumes/motivation";
import { linePaths, parseCitations, refsForLine } from "../citations";
import { SECTION_LABELS, WRITING_SECTIONS, type SectionId, type WritingSection } from "../job-types";
import { MAX_STEP_ATTEMPTS, parsedOutput } from "../next-step";
import { critiqueOf, currentPackV2, sectionOutput, sectionOutputAt } from "../next-step-v2";
import { buildWriteBodyPrompt, buildWriteTopPrompt } from "../prompts";
import { buildSectionPrompt } from "../prompts-v2";
import {
  LlmBodyDraftSchema,
  LlmTopDraftSchema,
  type AgentDraft,
  type Citation,
  type LlmSectionOutput,
  type SectionFragment,
  type SectionStepOutput,
} from "../schemas";
import { SECTION_AGENTS } from "../sections/agents";
import { feedbackRefs, fragmentDoc, lineChanges, ownsPath, pickFragment, restoreKeepPaths, reviewersFor, sameFragment, sectionEvidence, trimToBudget } from "../sections/common";
import { verifyDraft } from "../verify";
import { addUsage, agentPromptContext, AgentStepError, UsageMeter, ZERO_USAGE, type StepContext, type StepResult } from "./shared";

function baseOutput(section: SectionId, round: number): SectionStepOutput {
  return {
    section,
    round,
    fragment: {},
    citations: [],
    notes: [],
    missingInfo: [],
    needEvidence: [],
    coveredRequirementIds: [],
    retried: false,
    carriedFrom: null,
    fallback: null,
    changes: [],
    unchanged: false,
    verify: null,
    suggestion: null,
    skipped: false,
  };
}

export async function runSectionStep(ctx: StepContext, section: SectionId, round: number): Promise<StepResult<SectionStepOutput>> {
  if (section === "motivation_suggest") return runMotivationSuggestSection(ctx);
  if (section === "motivation_draft") return runMotivationDraftSection(ctx, round);
  return runWritingSection(ctx, section, round);
}

/** 다른 본문 구역이 라운드 k 이하에서 쓴 최신 조각(+ 인용). */
function otherSections(ctx: StepContext, section: WritingSection, round: number): { fragment: SectionFragment; citations: Citation[] } {
  const fragment: SectionFragment = {};
  const citations: Citation[] = [];
  for (const s of WRITING_SECTIONS) {
    if (s === section) continue;
    const o = sectionOutputAt(ctx.rows, s, round);
    if (!o) continue;
    Object.assign(fragment, o.output.fragment);
    citations.push(...o.output.citations);
  }
  return { fragment, citations };
}

/**
 * 같은 배치의 구역들이 같은 대체 호출을 나눠 쓴다(ctx.memo): 처음 부른 구역만 사용량을 센다. 실패도 함께 받되,
 * 사용량이 두 번 세지지 않게 나머지 구역에는 사용량 없는 오류로 넘긴다.
 */
async function sharedCall<T>(ctx: StepContext, key: string, make: () => Promise<GenerateResult<T>>): Promise<{ result: GenerateResult<T>; owner: boolean }> {
  const memo = ctx.memo;
  const hit = memo?.get(key) as Promise<GenerateResult<T>> | undefined;
  if (hit) {
    try {
      return { result: await hit, owner: false };
    } catch (err) {
      const e = new Error((err as Error)?.message ?? "fallback_failed");
      e.name = (err as Error)?.name ?? "Error";
      throw e;
    }
  }
  const p = make();
  memo?.set(key, p);
  p.catch(() => undefined);
  return { result: await p, owner: true };
}

/** 본문 구역(웨이브 1) 조각만 — 대체 상단 작성기의 입력(배치 안 두 구역이 같은 입력을 보게). */
function bodySections(ctx: StepContext, round: number): { fragment: SectionFragment; citations: Citation[] } {
  const fragment: SectionFragment = {};
  const citations: Citation[] = [];
  for (const s of ["experience", "projects", "extras"] as const) {
    const o = sectionOutputAt(ctx.rows, s, round);
    if (!o) continue;
    Object.assign(fragment, o.output.fragment);
    citations.push(...o.output.citations);
  }
  return { fragment, citations };
}

interface Written {
  draft: AgentDraft;
  invalidRefPaths: string[];
  out: Pick<LlmSectionOutput, "needEvidence" | "coveredRequirementIds">;
}

async function runWritingSection(ctx: StepContext, section: WritingSection, round: number): Promise<StepResult<SectionStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const brief = parsedOutput(ctx.rows, "brief", 0)?.brief;
  const pack = currentPackV2(ctx.rows, round);
  if (!jd || !brief || !pack) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const agent = SECTION_AGENTS[section];
  const assignment = brief.assignments.find((a) => a.section === section) ?? null;
  const requirementIds = new Set([...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => r.id));
  const packRefs = new Set(pack.items.map((i) => i.ref));
  const owns = (p: string) => ownsPath(section, p);
  const pctx = agentPromptContext(ctx.job.input);

  // 재작성 라운드: 이전 조각·총괄 피드백·연결 지적.
  const prev = round > 0 ? sectionOutputAt(ctx.rows, section, round - 1) : null;
  const feedback = round > 0 ? (critiqueOf(ctx.rows, round - 1)?.feedback.find((f) => f.section === section) ?? null) : null;
  const review = round > 0 ? parsedOutput(ctx.rows, "review", round - 1) : null;
  const linked = (review?.round.issues ?? []).filter((i) => feedback?.issueIds.includes(i.id));
  const others = otherSections(ctx, section, round);
  const showOthers = agent.wave === 2 || round > 0;

  // 근거 범위: 이 구역 소유 + 피드백 관련 + (핵심 성과·직무 역량) 다른 구역이 실제로 인용한 근거.
  const extra = feedbackRefs(pack, feedback);
  if (section === "highlights" || section === "skills") for (const c of others.citations) if (/^(experience|projects)\[/.test(c.path)) c.refs.forEach((r) => extra.add(r));
  const evidence = sectionEvidence(pack, brief, section, extra);

  const meter = new UsageMeter();
  const fallbackMode = round === 0 && (ctx.attempt ?? 1) >= MAX_STEP_ATTEMPTS;
  const write = async (retry: { uncited: string[] } | null): Promise<Written> => {
    let fragment: SectionFragment;
    let rawCitations: LlmSectionOutput["citations"];
    let notes: string[];
    let missingInfo: string[];
    let out: Written["out"] = { needEvidence: [], coveredRequirementIds: [] };
    if (fallbackMode && agent.wave === 1) {
      // v1 본문 작성기로 대체(작전 지시서는 plan의 확장이라 그대로 넘긴다) — 이 구역 칸만 잘라 쓴다.
      // 같은 배치의 다른 웨이브 1 구역도 대체 중이면 같은 호출 결과를 나눠 쓴다(본문 전체 호출을 한 번만).
      const { system, user } = buildWriteBodyPrompt(pctx, jd.jd, pack, brief, null);
      const shared = await sharedCall(ctx, `r${round}.fallback.write_body`, () =>
        ctx.llm.generate({ task: "resume-agent-write", system, user, schema: LlmBodyDraftSchema, effort: "medium", maxTokens: 32_000, signal: ctx.signal, cacheUser: false }),
      );
      const o = shared.owner ? meter.take(shared.result) : shared.result.output;
      fragment = pickFragment(section, { ...emptyResumeDocument(), experience: o.experience, projects: o.projects, education: o.education, certifications: o.certifications, extras: o.extras });
      rawCitations = o.citations;
      notes = o.notes.slice(0, 5);
      missingInfo = [];
    } else if (fallbackMode) {
      const b = bodySections(ctx, round);
      const body: AgentDraft = { document: fragmentDoc(b.fragment), citations: b.citations, notes: [], missingInfo: [] };
      const { system, user } = buildWriteTopPrompt(pctx, jd.jd, pack, brief, body, null);
      const shared = await sharedCall(ctx, `r${round}.fallback.write_top`, () =>
        ctx.llm.generate({ task: "resume-agent-write", system, user, schema: LlmTopDraftSchema, effort: "low", maxTokens: 16_000, signal: ctx.signal, cacheUser: false }),
      );
      const o = shared.owner ? meter.take(shared.result) : shared.result.output;
      fragment = section === "highlights" ? { highlights: o.highlights } : { skills: o.skills };
      rawCitations = o.citations;
      notes = [];
      missingInfo = o.missingInfo.slice(0, 5);
    } else {
      const { system, user } = buildSectionPrompt({
        ctx: pctx,
        section,
        round,
        jd: jd.jd,
        brief,
        assignment,
        evidence,
        otherSections: showOthers ? fragmentDoc(others.fragment) : null,
        rules: agent.rules,
        previous: prev ? fragmentDoc(prev.output.fragment) : null,
        feedback,
        retry,
        issues: linked.map((i, n) => ({ id: `I${n + 1}`, reviewer: i.reviewer, issue: i.issue, quote: i.quote })),
      });
      const o = meter.take(
        await ctx.llm.generate({ task: "resume-agent-section", system, user, schema: agent.schema, effort: agent.effort, maxTokens: agent.maxTokens, signal: ctx.signal, cacheUser: false }),
      );
      fragment = agent.toFragment(o);
      rawCitations = o.citations;
      notes = o.notes;
      missingInfo = o.missingInfo;
      out = { needEvidence: o.needEvidence, coveredRequirementIds: o.coveredRequirementIds };
    }
    const document = fragmentDoc(fragment);
    const parsed = parseCitations(rawCitations, document, packRefs, requirementIds);
    return {
      draft: { document, citations: parsed.citations.filter((c) => owns(c.path)), notes, missingInfo },
      invalidRefPaths: parsed.invalidRefPaths.filter(owns),
      out,
    };
  };

  const first = await write(null);
  let use = first;
  let retried = false;
  // 대체 경로(마지막 시도)는 같은 단계 재작성을 하지 않는다(시간·비용 — 인용 없는 줄은 아래 검증이 지운다).
  const check = verifyDraft(first.draft, pack, brief, { allowRetry: !fallbackMode, retryScope: owns, invalidRefPaths: first.invalidRefPaths });
  if (check.needsRetry && !fallbackMode) {
    retried = true;
    try {
      use = await write({ uncited: check.uncitedPaths });
    } catch (err) {
      // 다시 쓰기가 시간 상한·오류로 끝나지 못하면 첫 결과로 진행한다(인용 없는 줄은 지운다).
      meter.usage = addUsage(meter.usage, usageOfError(err));
    }
  }
  const verified = verifyDraft(use.draft, pack, brief, { allowRetry: false, retried, invalidRefPaths: use.invalidRefPaths });
  let fragment = pickFragment(section, verified.draft.document);
  let citations = verified.draft.citations.filter((c) => owns(c.path));
  const notes = [...use.draft.notes];

  const post = agent.postprocess?.(fragment, citations, { pack, others: others.fragment });
  if (post) {
    fragment = post.fragment;
    citations = post.citations;
    notes.push(...post.notes);
  }
  if (prev && feedback && feedback.keepPaths.length > 0) {
    const r = restoreKeepPaths(section, prev.output, { fragment, citations }, feedback.keepPaths);
    fragment = r.fragment;
    citations = r.citations;
    if (r.restored.length > 0) notes.push(`바꾸지 말라고 한 줄 ${r.restored.length}개를 되돌렸습니다.`);
  }
  let trimmed = 0;
  if (assignment) {
    const budget = feedback?.targetChars ? { ...assignment.budget, chars: Math.min(assignment.budget.chars, feedback.targetChars) } : assignment.budget;
    const t = trimToBudget(section, fragment, citations, budget, assignment.primaryRequirementIds);
    fragment = t.fragment;
    citations = t.citations;
    trimmed = t.trimmed;
    if (trimmed > 0) notes.push(`분량 예산을 넘어 ${trimmed}개 줄·항목을 줄였습니다.`);
  }

  // 근거가 있는데 경력·프로젝트를 하나도 못 썼으면 다시 시도한다(빈 구역으로 진행하지 않는다).
  const hasRole = pack.items.some((i) => i.label === "Role");
  const wantProjects = brief.include.projects.length > 0;
  if ((section === "experience" && hasRole && (fragment.experience ?? []).length === 0) || (section === "projects" && wantProjects && (fragment.projects ?? []).length === 0)) {
    throw new AgentStepError("section_empty", `${SECTION_LABELS[section]}을(를) 하나도 쓰지 못했습니다. 다시 시도합니다.`, false, undefined, meter.usage);
  }

  const changes = prev ? lineChanges(section, round, prev.output.fragment, fragment, { issueIds: feedback?.issueIds ?? [], reviewers: reviewersFor(feedback?.issueIds ?? [], review?.round.issues ?? []) }) : [];
  const unchanged = prev ? sameFragment(prev.output.fragment, fragment) : false;
  const output: SectionStepOutput = {
    ...baseOutput(section, round),
    fragment,
    citations: citations.slice(0, 120),
    notes: notes.slice(0, 10),
    missingInfo: verified.draft.missingInfo.slice(0, 10),
    needEvidence: use.out.needEvidence.slice(0, 3),
    coveredRequirementIds: [...new Set(use.out.coveredRequirementIds.filter((r) => requirementIds.has(r)))].slice(0, 20),
    retried,
    fallback: fallbackMode ? (agent.wave === 1 ? "v1_body" : "v1_top") : null,
    changes,
    unchanged,
    verify: verified.report,
  };
  return { output, summary: sectionSummary(section, output, assignment?.primaryRequirementIds ?? [], round), usage: meter.usage, model: meter.model };
}

/** 구역 카드 한 줄 요약: "R2·R5 담당 · 회사 3개 · 12줄 · 인용 100%". */
export function sectionSummary(section: WritingSection, out: SectionStepOutput, primary: readonly string[], round: number): string[] {
  const doc = fragmentDoc(out.fragment);
  const lines = linePaths(doc).filter((l) => ownsPath(section, l.path) && l.value.trim());
  const cited = lines.filter((l) => refsForLine(out.citations, l.path).length > 0).length;
  const f = out.fragment;
  const count =
    section === "experience"
      ? `회사 ${(f.experience ?? []).length}개`
      : section === "projects"
        ? `프로젝트 ${(f.projects ?? []).length}개`
        : section === "highlights"
          ? `성과 ${(f.highlights ?? []).length}개`
          : section === "skills"
            ? `기술 묶음 ${(f.skills ?? []).length}개`
            : `기타 ${(f.extras ?? []).reduce((n, x) => n + x.items.length, 0)}줄 · 학력 ${(f.education ?? []).length} · 자격 ${(f.certifications ?? []).length}`;
  const head = [primary.length ? `${primary.slice(0, 4).join("·")} 담당` : "", count, `${lines.length}줄`, lines.length ? `인용 ${Math.round((cited / lines.length) * 100)}%` : ""].filter(Boolean).join(" · ");
  const out2 = [head];
  if (out.fallback) out2.push("구역 에이전트가 끝내지 못해 기본 작성기로 썼습니다");
  else if (out.retried) out2.push("인용이 빠진 줄이 많아 한 번 다시 썼습니다");
  if (round > 0) out2.push(out.unchanged ? "피드백을 받았지만 바뀐 줄이 없습니다" : `바뀐 줄 ${out.changes.length}개`);
  return out2;
}

async function runMotivationSuggestSection(ctx: StepContext): Promise<StepResult<SectionStepOutput>> {
  const input = ctx.job.input;
  if (input.kind !== "company") return { output: { ...baseOutput("motivation_suggest", 0), skipped: true }, summary: ["공용 이력서라 지원 동기를 쓰지 않습니다"], usage: ZERO_USAGE, model: null };
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const pack = currentPackV2(ctx.rows, 0);
  if (!jd || !pack) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const res = await runMotivationSuggest(
    { company: input.company, roleTitle: input.roleTitle, jdText: input.jdText, jd: jd.jd, material: { kind: "pack", pack }, motivation: "" },
    { llm: ctx.llm, signal: ctx.signal, task: "resume-agent-motivation" },
  );
  const s = res.suggestion;
  return {
    output: { ...baseOutput("motivation_suggest", 0), suggestion: s },
    summary: [`회사가 강조하는 점 ${s.companyPoints.length} · 이어지는 경험 ${s.linkedExperiences.length} · 질문 ${s.questions.length}`],
    usage: addUsage(ZERO_USAGE, res.usage),
    model: res.model,
  };
}

async function runMotivationDraftSection(ctx: StepContext, round: number): Promise<StepResult<SectionStepOutput>> {
  const input = ctx.job.input;
  if (input.kind !== "company") return { output: { ...baseOutput("motivation_draft", round), skipped: true }, summary: ["공용 이력서라 지원 동기를 쓰지 않습니다"], usage: ZERO_USAGE, model: null };
  const brief = parsedOutput(ctx.rows, "brief", 0)?.brief;
  const pack = currentPackV2(ctx.rows, round);
  if (!brief || !pack) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const suggestion = sectionOutput(ctx.rows, "motivation_suggest", 0)?.suggestion ?? null;
  // 재료 줄: 이 라운드에서 쓰는 경력·프로젝트(재작성 라운드·고른 라운드의 본문 — 사라진 줄을 언급하지 않게).
  const body: SectionFragment = { ...(sectionOutputAt(ctx.rows, "experience", round)?.output.fragment ?? {}), ...(sectionOutputAt(ctx.rows, "projects", round)?.output.fragment ?? {}) };
  const resumeLines = linePaths(fragmentDoc(body))
    .filter((l) => /^(experience|projects)\[/.test(l.path) && l.value.trim() && !/^\s*\[ADD:/.test(l.value))
    .map((l) => l.value);
  const previous = round > 0 ? (sectionOutputAt(ctx.rows, "motivation_draft", round - 1)?.output.fragment.motivation ?? "") : "";
  const feedback = round > 0 ? (critiqueOf(ctx.rows, round - 1)?.motivation?.instructions ?? []) : [];
  const res = await writeMotivationDraft(
    { company: input.company, roleTitle: input.roleTitle, jdText: input.jdText, pack, suggestion, resumeLines, angle: brief.motivation, previous, feedback },
    { llm: ctx.llm, signal: ctx.signal },
  );
  const summary = res.draft ? [`초안 ${res.draft.length}자 · 직접 채울 자리 ${res.placeholders}곳`] : ["근거로 쓸 내용이 없어 지원 동기 칸을 비워 둡니다"];
  if (round > 0) summary.push(feedback.length ? `총괄 피드백 ${feedback.length}개를 반영해 다시 썼습니다` : "바뀐 본문에 맞춰 다시 썼습니다");
  if (!suggestion) summary.push("추천 재료 없이 작전·본문만으로 썼습니다");
  return { output: { ...baseOutput("motivation_draft", round), fragment: { motivation: res.draft } }, summary, usage: addUsage(ZERO_USAGE, res.usage), model: res.model };
}
