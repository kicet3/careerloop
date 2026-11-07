/**
 * 단계 critique(v2 총괄 피드백, task resume-agent-critique — docs/RESUME-SECTION-AGENTS.md §4.3):
 *   1) 결정적 라우팅: 심사 지적의 경로 접두로 구역을 정한다(experience[ → 경력 …, summary·basics. → compose, 지원 동기는 대상 아님).
 *      경로 없는 지적·적합도 missing/partial 요건은 작전의 주 책임 구역으로, ATS 누락 키워드는 그 키워드를 맡은 구역(없으면 경력)으로.
 *      needsUserInfo 지적은 피드백에서 빼고 질문으로만 남긴다. 분량 초과·구역 사이 중복도 그 구역으로.
 *   2) 총괄 LLM: 구역별 점수·keep|revise·지시. 3) 서버 정리: 지적·요건·분량 초과가 없는 구역의 revise는 keep으로 강등,
 *      한 라운드 MAX_SECTIONS_PER_ROUND(점수 낮은 순). 지시문은 길이·개수를 자르고 태그 문자를 지운다.
 *   4) 다음 라운드 근거 재검색(ctx.evidence.expand — 작업 행 userId만): 요건 공백·누락 키워드·구역의 needEvidence·총괄 검색어.
 *      아무것도 못 찾은 요건은 질문으로 돌리고 그 요건만으로 다시 쓰라던 구역은 빼낸다.
 * LLM이 실패하면 결정적 라우팅만으로(지시 = 지적 문장) 진행한다 — 작업을 실패시키지 않는다.
 */
import { compactKey } from "@/lib/skills/dictionary";
import { graphEvidenceSource } from "../evidence-source";
import { WRITING_SECTIONS, type WritingSection } from "../job-types";
import { parsedOutput } from "../next-step";
import { composeOf, currentPackV2, MAX_SECTIONS_PER_ROUND, sectionOutputAt } from "../next-step-v2";
import { buildCritiquePrompt, cleanInstruction } from "../prompts-v2";
import { LlmCritiqueSchema, type ComposeStepOutput, type CritiqueStepOutput, type EvidencePack, type LlmCritique, type ReviewRound, type SectionBrief, type SectionFeedback } from "../schemas";
import { fragmentDoc, nearDuplicate, ownsPath, sectionOfPath } from "../sections/common";
import { linePaths } from "../citations";
import { splitSentences } from "../verify";
import { stripPlaceholders } from "@/lib/text/numbers";
import { usageOfError } from "@/lib/llm/types";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { addUsage, agentPromptContext, AgentStepError, UsageMeter, type StepContext, type StepResult } from "./shared";

type Target = WritingSection | "compose";

interface Routed {
  issueIds: Set<string>;
  requirementIds: Set<string>;
  keywords: Set<string>;
  quotes: string[];
  texts: string[];
  overBudget: boolean;
  severe: boolean;
}

const emptyRouted = (): Routed => ({ issueIds: new Set(), requirementIds: new Set(), keywords: new Set(), quotes: [], texts: [], overBudget: false, severe: false });

/** 1) 결정적 라우팅(순수 — 테스트용으로 내보낸다). */
export function routeFeedback(
  review: ReviewRound,
  brief: SectionBrief,
  compose: Pick<ComposeStepOutput, "budgetReport" | "duplicates">,
  jd: JdAnalysis,
  pack: EvidencePack | null,
): { routed: Map<Target, Routed>; questions: CritiqueStepOutput["questions"] } {
  const routed = new Map<Target, Routed>();
  const get = (t: Target) => {
    if (!routed.has(t)) routed.set(t, emptyRouted());
    return routed.get(t)!;
  };
  const primaryOf = (req: string): WritingSection => brief.assignments.find((a) => a.primaryRequirementIds.includes(req))?.section ?? "experience";
  const reqText = new Map([...jd.mustHave, ...jd.niceToHave].map((r) => [r.id, r.text]));
  const questions: CritiqueStepOutput["questions"] = [];
  const asked = new Set<string>();

  for (const i of review.issues) {
    if (i.needsUserInfo) {
      const key = i.requirementId ?? i.issue;
      if (!asked.has(key) && questions.length < 10) {
        asked.add(key);
        const t = i.requirementId ? reqText.get(i.requirementId) : null;
        questions.push({ requirementId: i.requirementId, question: t ? `${t} 경험이 있나요? 있다면 어느 직무·프로젝트에서 했는지 알려 주세요.` : i.issue.slice(0, 200) });
      }
      continue;
    }
    const severe = i.severity !== "minor";
    const isKeyword = i.reviewer === "ats" && i.quote === null && /^JD 키워드/.test(i.issue);
    if (isKeyword) continue; // 키워드는 아래에서 키워드별로 배정한다.
    let targets: Target[] = [...new Set(i.paths.map(sectionOfPath).filter((x): x is Target => x !== null))];
    if (targets.length === 0) {
      if (i.requirementId) targets = [primaryOf(i.requirementId)];
      else if (severe) targets = ["experience"];
      else continue;
    }
    if (!severe && i.reviewer !== "verify" && !i.requirementId) continue; // 경로 있는 사소한 지적은 총괄이 판단(LLM)
    for (const t of targets) {
      const r = get(t);
      r.issueIds.add(i.id);
      if (i.requirementId) r.requirementIds.add(i.requirementId);
      if (i.quote) r.quotes.push(i.quote.slice(0, 300));
      r.texts.push(i.issue.slice(0, 200));
      r.severe ||= severe;
    }
  }
  // ATS 누락 키워드 → 그 키워드를 맡은 구역 → 그 키워드가 든 근거의 소유 구역 → 경력.
  const atsIssue = review.issues.find((i) => i.reviewer === "ats" && i.quote === null && /^JD 키워드/.test(i.issue));
  const owner = new Map(brief.evidenceOwner.map((o) => [o.ref, o.section]));
  for (const kw of review.atsKeywordsMissing.slice(0, 12)) {
    const key = compactKey(kw);
    let t: WritingSection | undefined = brief.assignments.find((a) => a.keywords.some((k) => compactKey(k) === key))?.section;
    if (!t && pack) {
      const hit = pack.items.find((i) => i.label !== "Skill" && compactKey(`${i.name} ${i.text} ${i.skills.join(" ")}`).includes(key));
      const o = hit ? owner.get(hit.ref) : undefined;
      t = o === "projects" || o === "experience" ? o : undefined;
    }
    if (t === "skills" || t === "highlights" || !t) t = "experience";
    const r = get(t);
    r.keywords.add(kw);
    r.severe = true;
    if (atsIssue) r.issueIds.add(atsIssue.id);
  }
  // 적합도 공백(경로 없는 지적으로 이미 들어오지만, 요건 id를 주 책임 구역에 확실히 단다).
  for (const f of review.fitItems) {
    if (f.status === "met" || asked.has(f.requirementId)) continue;
    const r = get(primaryOf(f.requirementId));
    r.requirementIds.add(f.requirementId);
  }
  for (const b of compose.budgetReport) {
    if (!b.over) continue;
    const r = get(b.section);
    r.overBudget = true;
    r.texts.push(`분량 예산(${b.budget}자)을 넘었다(${b.chars}자) — 주 책임 요건과 무관한 줄부터 줄인다.`);
  }
  for (const d of compose.duplicates) {
    if (d.removed) continue;
    const r = get(d.section);
    r.texts.push(`${d.path}는 다른 구역이 상세히 쓰는 근거(${d.ref})를 되풀이한다 — 한 줄 이하로 줄이거나 지운다.`);
  }
  return { routed, questions };
}

/**
 * 근거를 못 찾은 요건 정리(순수 — 테스트용): 그 요건 id를 빼고, 그 요건(id·요건 문장)을 언급한 지시도 지운다(지어내도록 압박하지 않게).
 * 그 뒤 남은 사유(지적·남은 요건·키워드·분량 초과·중복)가 없는 구역은 뺀다 — 지시문이 남아 있다는 것만으로는 다시 쓰지 않는다.
 */
export function dropUnresolved(
  feedback: readonly SectionFeedback[],
  unresolved: ReadonlySet<string>,
  reqs: ReadonlyMap<string, { text: string }>,
  ctx: { issues: readonly Pick<ReviewRound["issues"][number], "id" | "requirementId">[]; compose: Pick<ComposeStepOutput, "budgetReport" | "duplicates"> },
): SectionFeedback[] {
  if (unresolved.size === 0) return [...feedback];
  const reqIdRe = [...unresolved].map((id) => new RegExp(`(^|[^A-Za-z0-9])${id}(?![0-9])`));
  const reqTexts = [...unresolved].map((id) => compactKey(reqs.get(id)?.text ?? "")).filter((t) => t.length >= 4);
  const issueReq = new Map(ctx.issues.map((i) => [i.id, i.requirementId]));
  const mentionsUnresolved = (x: string) => reqIdRe.some((re) => re.test(x)) || reqTexts.some((t) => compactKey(x).includes(t));
  return feedback.flatMap((f) => {
    const requirementIds = f.requirementIds.filter((r) => !unresolved.has(r));
    const instructions = f.instructions.filter((x) => !mentionsUnresolved(x));
    // 미해결 요건에 걸린 지적은 사유로 치지 않는다(요건 없는 지적·다른 요건 지적·모르는 id는 사유).
    const otherIssues = f.issueIds.some((id) => {
      const req = issueReq.get(id);
      return req === undefined || req === null || !unresolved.has(req);
    });
    const overBudget = ctx.compose.budgetReport.some((b) => b.section === f.section && b.over);
    const duplicate = ctx.compose.duplicates.some((d) => d.section === f.section && !d.removed);
    const reason = otherIssues || requirementIds.length > 0 || f.keywords.length > 0 || !!overBudget || duplicate;
    if (!reason) return [];
    return [{ ...f, requirementIds, instructions: instructions.length > 0 ? instructions : ["지적된 줄을 근거 안에서 고친다. 근거가 없는 요건은 쓰지 않는다."] }];
  });
}

/**
 * 지원 동기 초안 점검(결정적, 순수 — 테스트용): 심사위원은 지원 동기를 보지 않으므로 총괄이 직접 본다.
 *   - 본문(경력·프로젝트) 줄을 거의 그대로 옮긴 문장 → 회사가 강조하는 점과 잇는 한 문장으로.
 *   - 공고가 있는데 JD 요건·키워드와 이어지는 말이 하나도 없음 → 근거가 있는 요건 하나와 잇기.
 * 지시가 없으면 null(다시 쓰지 않는다). 자리표시만 있는 초안·빈 초안은 보지 않는다.
 */
export function critiqueMotivation(draft: string, doc: Pick<ComposeStepOutput["draft"]["document"], "experience" | "projects">, jd: JdAnalysis): { instructions: string[] } | null {
  const body = stripPlaceholders(draft).trim();
  if (body.length < 20) return null;
  const instructions: string[] = [];
  const lines = linePaths({ ...fragmentDoc({}), experience: doc.experience, projects: doc.projects })
    .filter((l) => /^(experience|projects)\[/.test(l.path) && l.value.trim().length >= 12)
    .map((l) => l.value);
  const copied = splitSentences(body).find((sentence) => {
    const c = compactKey(sentence);
    return lines.some((l) => nearDuplicate(sentence, l) || (compactKey(l).length >= 15 && c.includes(compactKey(l))));
  });
  if (copied) instructions.push(cleanInstruction(`이력서 본문 줄을 거의 그대로 옮긴 문장이 있다('${copied.trim().slice(0, 60)}') — 본문을 반복하지 말고 회사가 강조하는 점과 이어지는 한 문장으로 줄인다.`));
  if (jd.source !== "inferred") {
    const c = compactKey(body);
    const terms = [...jd.keywords, ...jd.mustHave.map((r) => r.text), ...jd.responsibilities].map(compactKey).filter((t) => t.length >= 2);
    const linked = terms.some((t) => c.includes(t)) || jd.keywords.some((k) => c.includes(compactKey(k)));
    if (!linked && terms.length > 0) {
      const top = [...jd.mustHave.map((r) => r.text), ...jd.keywords].slice(0, 3).join(", ");
      instructions.push(cleanInstruction(`JD 요건·키워드와 경험의 연결이 보이지 않는다 — 근거가 있는 요건(${top} 중) 하나와 실제로 한 일을 잇는다. 근거가 없으면 [ADD]로 남긴다.`));
    }
  }
  return instructions.length > 0 ? { instructions: instructions.slice(0, 5) } : null;
}

const hasWork = (r: Routed | undefined) => !!r && (r.issueIds.size > 0 || r.requirementIds.size > 0 || r.keywords.size > 0 || r.overBudget || r.texts.length > 0);

/** 3) 서버 정리(순수 — 테스트용). LLM 결과가 없으면 결정적 피드백. */
export function mergeCritique(
  routed: ReadonlyMap<Target, Routed>,
  llm: LlmCritique | null,
  shortIds: ReadonlyMap<string, string>,
  maxSections = MAX_SECTIONS_PER_ROUND,
): { feedback: SectionFeedback[]; composeFeedback: string[]; sectionScores: CritiqueStepOutput["sectionScores"] } {
  const feedback: SectionFeedback[] = [];
  const sectionScores: CritiqueStepOutput["sectionScores"] = [];
  for (const s of WRITING_SECTIONS) {
    const r = routed.get(s);
    const e = llm?.sections.find((x) => x.section === s);
    const score = e?.score ?? null;
    const work = hasWork(r);
    // 근거 없는 재작성 방지: 지적·요건·키워드·분량 초과가 없으면 LLM이 revise라 해도 keep.
    // LLM이 명시적으로 keep이라 했어도 심각한 지적·누락 키워드가 있으면 다시 쓴다.
    const revise = work && (!e || e.decision === "revise" || !!r?.severe || (r?.keywords.size ?? 0) > 0);
    sectionScores.push({ section: s, score, decision: revise ? "revise" : "keep" });
    if (!revise || !r) continue;
    const llmIssues = (e?.issueIds ?? []).map((id) => shortIds.get(id)).filter((x): x is string => !!x);
    const instructions = [...(e?.instructions ?? []).map((x) => cleanInstruction(x)).filter(Boolean)];
    if (instructions.length === 0) instructions.push(...r.texts.map((x) => cleanInstruction(x)));
    if (r.keywords.size > 0) instructions.push(cleanInstruction(`서류 자동 필터가 못 찾은 JD 키워드(${[...r.keywords].join(", ")})를 근거가 있는 줄에 JD 표기 그대로 넣는다. 근거가 없으면 넣지 않는다.`));
    feedback.push({
      section: s,
      score,
      instructions: [...new Set(instructions)].slice(0, 8),
      issueIds: [...new Set([...r.issueIds, ...llmIssues])].slice(0, 20),
      requirementIds: [...new Set([...r.requirementIds, ...(e?.requirementIds ?? [])])].slice(0, 10),
      keepPaths: (e?.keepPaths ?? []).filter((p) => ownsPath(s, p)).slice(0, 20),
      targetChars: e?.targetChars ?? null,
      quotes: [...new Set(r.quotes)].slice(0, 8),
      keywords: [...r.keywords].slice(0, 12),
    });
  }
  feedback.sort((a, b) => (a.score ?? 50) - (b.score ?? 50));
  const composeEntry = llm?.sections.find((x) => x.section === "compose");
  const composeRouted = routed.get("compose");
  const composeFeedback =
    composeEntry?.decision === "revise" && composeEntry.instructions.length > 0
      ? composeEntry.instructions.map((x) => cleanInstruction(x))
      : hasWork(composeRouted)
        ? composeRouted!.texts.map((x) => cleanInstruction(x))
        : [];
  return { feedback: feedback.slice(0, maxSections), composeFeedback: [...new Set(composeFeedback)].filter(Boolean).slice(0, 6), sectionScores };
}

export async function runCritiqueStep(ctx: StepContext, k: number): Promise<StepResult<CritiqueStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const brief = parsedOutput(ctx.rows, "brief", 0)?.brief;
  const compose = composeOf(ctx.rows, k);
  const review = parsedOutput(ctx.rows, "review", k);
  const pack0 = currentPackV2(ctx.rows, k);
  if (!jd || !brief || !compose || !review || !pack0) throw new AgentStepError("missing_input", "피드백할 초안·심사 결과가 없습니다.", false);
  const meter = new UsageMeter();
  const { routed, questions } = routeFeedback(review.round, brief, compose, jd.jd, pack0);

  // 지적 id를 짧은 번호로(I1…): 프롬프트에 내부 id를 넣지 않는다.
  const shortIds = new Map<string, string>();
  const issues = review.round.issues
    .filter((i) => !i.needsUserInfo)
    .slice(0, 40)
    .map((i, n) => {
      shortIds.set(`I${n + 1}`, i.id);
      return { id: `I${n + 1}`, reviewer: i.reviewer, severity: i.severity, paths: i.paths, quote: i.quote, issue: i.issue, requirementId: i.requirementId };
    });
  const longToShort = new Map([...shortIds].map(([s, l]) => [l, s]));
  const reqGaps = review.round.fitItems.filter((f) => f.status !== "met").map((f) => ({ requirementId: f.requirementId, status: f.status, note: f.note }));
  const cited = new Set(compose.draft.citations.flatMap((c) => c.refs));
  const evidence = pack0.items.filter((i) => cited.has(i.ref) || i.label === "Role" || i.label === "Company" || reqGaps.some((g) => pack0.byRequirement.find((b) => b.requirementId === g.requirementId)?.refs.includes(i.ref)));
  const missingInfo = WRITING_SECTIONS.map((s) => ({ section: s, items: sectionOutputAt(ctx.rows, s, k)?.output.missingInfo.slice(0, 5) ?? [] })).filter((m) => m.items.length > 0);

  let llm: LlmCritique | null = null;
  try {
    const { system, user } = buildCritiquePrompt({
      ctx: agentPromptContext(ctx.job.input),
      jd: jd.jd,
      brief,
      doc: compose.draft.document,
      issues,
      review: {
        atsPass: review.round.atsPass,
        passCount: review.round.passCount,
        passTotal: review.round.passTotal,
        matchScore: review.round.matchScore,
        atsKeywordsMissing: review.round.atsKeywordsMissing,
        requirementGaps: reqGaps,
      },
      budgetReport: compose.budgetReport,
      duplicates: compose.duplicates.filter((d) => !d.removed),
      missingInfo,
      routed: [...routed].map(([section, r]) => ({
        section,
        issueIds: [...r.issueIds].map((id) => longToShort.get(id)).filter((x): x is string => !!x),
        requirementIds: [...r.requirementIds],
        keywords: [...r.keywords],
        overBudget: r.overBudget,
      })),
      evidence,
      round: k,
      maxSections: MAX_SECTIONS_PER_ROUND,
    });
    llm = meter.take(await ctx.llm.generate({ task: "resume-agent-critique", system, user, schema: LlmCritiqueSchema, effort: "medium", maxTokens: 12_000, signal: ctx.signal, cacheUser: false }));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    meter.usage = addUsage(meter.usage, usageOfError(err));
    llm = null;
  }
  const merged = mergeCritique(routed, llm, shortIds);

  // 4) 다음 라운드 근거 재검색.
  const reqs = new Map([...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => [r.id, r]));
  const targets: { requirementId: string | null; query: string }[] = [
    ...reqGaps.map((g) => ({ requirementId: g.requirementId, query: [reqs.get(g.requirementId)?.text ?? "", reqs.get(g.requirementId)?.jdQuote ?? ""].join(" ").trim() })).filter((t) => t.query),
    ...review.round.atsKeywordsMissing.map((kw) => ({ requirementId: null, query: kw })),
    ...WRITING_SECTIONS.flatMap((s) => sectionOutputAt(ctx.rows, s, k)?.output.needEvidence ?? []),
    ...(llm?.sections.flatMap((x) => x.evidenceQueries.map((q) => ({ requirementId: null, query: q }))) ?? []),
  ].slice(0, 20);
  const source = ctx.evidence ?? graphEvidenceSource(ctx.loadGraph);
  let pack: EvidencePack | null = null;
  let expand: CritiqueStepOutput["expand"] = { added: 0, graphChanged: false, unresolved: [] };
  let feedback = merged.feedback;
  if (merged.feedback.length > 0 && targets.length > 0) {
    const ex = await source.expand({ userId: ctx.job.userId, pack: pack0, targets, nowYear: ctx.nowYear });
    expand = { added: ex.added, graphChanged: ex.graphChanged, unresolved: ex.unresolved };
    if (ex.added > 0 || ex.graphChanged) pack = ex.pack;
    const unresolved = new Set(ex.unresolved.filter((id) => !(pack ?? pack0).byRequirement.find((b) => b.requirementId === id)?.refs.length));
    for (const id of unresolved) {
      if (questions.some((q) => q.requirementId === id) || questions.length >= 10) continue;
      const t = reqs.get(id)?.text;
      if (t) questions.push({ requirementId: id, question: `${t} 경험이 있나요? 있다면 어느 직무·프로젝트에서 했는지 알려 주세요.` });
    }
    feedback = dropUnresolved(feedback, unresolved, reqs, { issues: review.round.issues, compose });
  }
  // 지원 동기 초안(이 라운드까지의 최신): 다시 쓸 본문 구역이 있는 라운드에만 함께 다시 쓴다(next-step-v2).
  const motivationOn = ctx.job.input.kind === "company" && ctx.settings.motivation !== false;
  const draftNow = motivationOn ? (sectionOutputAt(ctx.rows, "motivation_draft", k)?.output.fragment.motivation ?? "") : "";
  const motivation = draftNow ? critiqueMotivation(draftNow, compose.draft.document, jd.jd) : null;
  const summary = cleanInstruction(llm?.summary || (feedback.length ? `${feedback.length}개 구역에 피드백을 보냅니다.` : "다시 쓸 구역이 없습니다."), 400);
  const label = (s: string) => ({ experience: "경력", projects: "대표 프로젝트", highlights: "핵심 성과", skills: "직무 역량", extras: "수상·기타" })[s] ?? s;
  const lines = [
    feedback.length ? `다시 쓸 구역: ${feedback.map((f) => label(f.section)).join(" · ")}` : "다시 쓸 구역 없음",
    merged.composeFeedback.length ? "요약·상단도 다시 씁니다" : "",
    motivation && feedback.length ? `지원 동기 초안 피드백 ${motivation.instructions.length}개` : "",
    `근거 추가 ${expand.added}개 · 질문으로 넘김 ${questions.length}개`,
    llm ? "" : "총괄 피드백 호출이 끝나지 않아 심사 지적을 그대로 넘깁니다",
  ].filter(Boolean);
  return {
    output: {
      round: k,
      feedback,
      composeFeedback: merged.composeFeedback,
      questions: questions.slice(0, 10),
      summary,
      sectionScores: merged.sectionScores,
      fallback: llm === null,
      pack,
      expand,
      motivation,
    },
    summary: lines,
    usage: meter.usage,
    model: meter.model,
  };
}
