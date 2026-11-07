/**
 * 단계 compose(v2 총괄, 라운드마다 — docs/RESUME-SECTION-AGENTS.md §4.1):
 *   1) 조립(결정적): 구역마다 라운드 k 이하의 최신 done 출력을 빈 문서에 합친다(실패한 구역은 이전 라운드 출력).
 *   2) 교차 구역 중복(결정적): 다른 구역이 소유한 근거를 상세 인용한 줄은 duplicates로 기록(critique에 넘긴다), 경력·프로젝트에 거의 같은
 *      문장이 있으면 소유 구역이 아닌 쪽을 지운다.
 *   3) 상단(LLM, task resume-agent-compose): headline·tagline·summary — 본문에 이미 인용된 ref만 허용. 실패하면 작전의 headline·positioning으로 결정적 대체.
 *   4) 사실 검증: 조립 문서 전체에 verifyDraft(v1 그대로). 5) 분량 측정: 구역별 글자 수·예산, 전체 쪽수 추정.
 * compose는 LLM 실패로 작업을 실패시키지 않는다.
 */
import { usageOfError } from "@/lib/llm/types";
import { linePaths, parseCitations, refsForLine } from "../citations";
import { WRITING_SECTIONS, type WritingSection } from "../job-types";
import { parsedOutput } from "../next-step";
import { composeOf, critiqueOf, currentPackV2, sectionOutput, sectionOutputAt } from "../next-step-v2";
import { buildComposePrompt } from "../prompts-v2";
import { LlmComposeTopSchema, type AgentDraft, type Citation, type ComposeStepOutput, type SectionFragment } from "../schemas";
import { fragmentChars, fragmentDoc, nearDuplicate, pickFragment, removeElement } from "../sections/common";
import { draftIsEmpty, verifyDraft } from "../verify";
import { PAGE_CHARS } from "./brief";
import { addUsage, agentPromptContext, AgentStepError, previewText, UsageMeter, type StepContext, type StepResult } from "./shared";

/** 1)·2) 조립과 교차 구역 중복 처리(순수 — 테스트용으로 내보낸다). */
export function assembleSections(
  parts: readonly { section: WritingSection; fragment: SectionFragment; citations: readonly Citation[] }[],
  owner: ReadonlyMap<string, WritingSection>,
): { draft: AgentDraft; duplicates: ComposeStepOutput["duplicates"] } {
  const doc = fragmentDoc({});
  let citations: Citation[] = [];
  const notes: string[] = [];
  for (const p of parts) {
    Object.assign(doc, structuredClone(p.fragment));
    citations.push(...p.citations);
  }
  doc.motivation = "";
  const duplicates: ComposeStepOutput["duplicates"] = [];
  // 다른 구역 소유 근거를 상세 인용한 본문 줄(경력·프로젝트·기타). 핵심 성과·직무 역량은 한 줄 요약·이름으로 허용.
  for (const c of citations) {
    const section = (["experience", "projects", "extras"] as const).find((s) => (s === "extras" ? /^(extras|education|certifications)\[/ : new RegExp(`^${s}\\[`)).test(c.path));
    if (!section) continue;
    for (const ref of c.refs) {
      const o = owner.get(ref);
      if (o && o !== section && o !== "highlights" && o !== "skills") duplicates.push({ ref, section, owner: o, path: c.path, removed: false });
    }
  }
  // 경력 불릿과 프로젝트 줄이 거의 같으면 소유 구역이 아닌 쪽을 지운다(소유를 모르면 경력 쪽).
  const projLines = linePaths(doc).filter((l) => /^projects\[/.test(l.path) && l.value.trim());
  for (let i = doc.experience.length - 1; i >= 0; i--) {
    for (let j = doc.experience[i]!.bullets.length - 1; j >= 0; j--) {
      const path = `experience[${i}].bullets[${j}]`;
      const value = doc.experience[i]!.bullets[j]!;
      const twin = projLines.find((l) => nearDuplicate(value, l.value));
      if (!twin) continue;
      const refs = refsForLine(citations, path);
      const ownedByExperience = refs.some((r) => owner.get(r) === "experience") && !refsForLine(citations, twin.path).some((r) => owner.get(r) === "projects");
      if (ownedByExperience) continue;
      citations = removeElement(doc, citations, path);
      duplicates.push({ ref: refs[0] ?? "", section: "experience", owner: "projects", path, removed: true });
    }
  }
  // 핵심 성과가 조립된 경력·프로젝트 줄과 거의 같으면 핵심 성과 쪽을 지운다(같은 라운드에 함께 다시 쓰여 구역 후처리가
  // 이전 본문과만 비교한 경우의 안전망). 핵심 성과가 하나만 남으면 지우지 않는다.
  const bodyLines = linePaths(doc).filter((l) => /^(experience|projects)\[/.test(l.path) && l.value.trim());
  for (let i = doc.highlights.length - 1; i >= 0 && doc.highlights.length > 1; i--) {
    const h = doc.highlights[i]!;
    const path = `highlights[${i}]`;
    if (!bodyLines.some((l) => nearDuplicate(h.title, l.value))) continue;
    const refs = refsForLine(citations, path);
    citations = removeElement(doc, citations, path);
    duplicates.push({ ref: refs[0] ?? "", section: "highlights", owner: owner.get(refs[0] ?? "") ?? "experience", path, removed: true });
  }
  const removedBody = duplicates.filter((d) => d.removed && d.section === "experience").length;
  const removedTop = duplicates.filter((d) => d.removed && d.section === "highlights").length;
  if (removedBody > 0) notes.push(`경력과 대표 프로젝트에 겹친 문장 ${removedBody}개를 정리했습니다.`);
  if (removedTop > 0) notes.push(`본문 줄과 거의 같은 핵심 성과 ${removedTop}개를 뺐습니다.`);
  return { draft: { document: doc, citations, notes, missingInfo: [] }, duplicates: duplicates.slice(0, 60) };
}

export async function runComposeStep(ctx: StepContext, k: number): Promise<StepResult<ComposeStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const brief = parsedOutput(ctx.rows, "brief", 0)?.brief;
  const pack = currentPackV2(ctx.rows, k);
  if (!jd || !brief || !pack) throw new AgentStepError("missing_input", "앞 단계 결과가 없습니다.", false);
  const meter = new UsageMeter();
  const owner = new Map(brief.evidenceOwner.map((o) => [o.ref, o.section]));

  const used: ComposeStepOutput["sectionsUsed"] = [];
  const parts = [];
  const missing: string[] = [];
  const notes: string[] = [];
  for (const s of WRITING_SECTIONS) {
    const at = sectionOutputAt(ctx.rows, s, k);
    if (!at) continue;
    const exact = k > 0 && ctx.rows.some((r) => r.key === `r${k}.sec.${s}`);
    used.push({ section: s, round: at.round, fallback: (exact && at.round < k) || at.output.fallback !== null });
    parts.push({ section: s, fragment: at.output.fragment, citations: at.output.citations });
    missing.push(...at.output.missingInfo);
    notes.push(...at.output.notes.slice(0, 2));
  }
  if (!parts.some((p) => p.section === "extras")) notes.push("수상·기타 구역을 쓰지 못해 비워 두었습니다. 학력·자격·수상은 저장 뒤 직접 확인해 주세요.");
  const assembled = assembleSections(parts, owner);
  if (draftIsEmpty(assembled.draft.document)) throw new AgentStepError("draft_empty", "근거가 있는 경력·프로젝트가 없습니다. 다시 시도합니다.", false);

  // 3) 상단: 본문에 이미 인용된 ref만.
  const allowedRefs = [...new Set(assembled.draft.citations.flatMap((c) => c.refs))];
  const allowed = new Set(allowedRefs);
  const composeFeedback = k > 0 ? (critiqueOf(ctx.rows, k - 1)?.composeFeedback ?? []) : [];
  const doc = assembled.draft.document;
  let citations = assembled.draft.citations;
  let topFallback = false;
  try {
    const evidence = pack.items.filter((i) => allowed.has(i.ref));
    const { system, user } = buildComposePrompt(agentPromptContext(ctx.job.input), jd.jd, brief, doc, evidence, allowedRefs, composeFeedback);
    const top = meter.take(await ctx.llm.generate({ task: "resume-agent-compose", system, user, schema: LlmComposeTopSchema, effort: "low", maxTokens: 6_000, signal: ctx.signal, cacheUser: false }));
    doc.basics.headline = (brief.headline || top.headline).slice(0, 160);
    doc.basics.tagline = top.tagline;
    doc.summary = top.summary.slice(0, Math.max(brief.summaryChars * 2, 400));
    const parsed = parseCitations(
      top.citations.map((c) => ({ ...c, refs: c.refs.filter((r) => allowed.has(r.trim().replace(/^\[|\]$/g, ""))) })),
      doc,
      allowed,
      new Set([...jd.jd.mustHave, ...jd.jd.niceToHave].map((r) => r.id)),
    );
    citations = [...citations, ...parsed.citations.filter((c) => c.path === "summary" || c.path.startsWith("basics."))];
  } catch (err) {
    if (ctx.signal.aborted) throw err; // 리스를 잃었거나 단계 시간이 다 됐다(다음 시도가 다시 한다)
    meter.usage = addUsage(meter.usage, usageOfError(err));
    topFallback = true;
    // 결정적 대체: 작전의 headline, 요약은 포지셔닝 문장(본문의 주 책임 근거 인용).
    doc.basics.headline = brief.headline.slice(0, 160);
    doc.basics.tagline = "";
    const strong = brief.requirementMap.filter((r) => r.status !== "gap").flatMap((r) => r.refs).filter((r) => allowed.has(r));
    const refs = [...new Set(strong.length ? strong : allowedRefs)].slice(0, 3);
    doc.summary = refs.length ? brief.positioning : "";
    if (refs.length) citations = [...citations, { path: "summary", refs, requirementIds: [] }];
    notes.push("요약을 쓰는 호출이 끝나지 않아 작전의 포지셔닝 문장으로 채웠습니다.");
  }

  // 4) 사실 검증(조립 문서 전체).
  const verified = verifyDraft({ document: doc, citations, notes: [...assembled.draft.notes, ...notes].slice(0, 20), missingInfo: [...new Set([...missing, ...brief.gapQuestions.map((g) => g.question)])].slice(0, 30) }, pack, brief, { allowRetry: false });
  verified.draft.document.motivation = "";

  // 5) 분량.
  const budgetReport = WRITING_SECTIONS.map((s) => {
    const chars = fragmentChars(pickFragment(s, verified.draft.document));
    const budget = brief.assignments.find((a) => a.section === s)?.budget.chars ?? 0;
    return { section: s, chars, budget, over: budget > 0 && chars > budget * 1.1 };
  });
  const total = budgetReport.reduce((n, b) => n + b.chars, 0) + verified.draft.document.summary.length;
  const pages = Math.round((total / PAGE_CHARS) * 10) / 10;

  // 다시 쓴 구역이 모두 이전과 같고(또는 실패해 이전 결과) 상단 지시도 없으면 unchanged.
  const rewritten = k > 0 ? (critiqueOf(ctx.rows, k - 1)?.feedback ?? []).map((f) => f.section) : [];
  const unchanged = k > 0 && composeFeedback.length === 0 && rewritten.every((s) => !sectionOutput(ctx.rows, s, k) || sectionOutput(ctx.rows, s, k)!.unchanged);
  if (k > 0 && unchanged && composeOf(ctx.rows, k - 1)) verified.draft.notes = [...verified.draft.notes, "피드백을 받은 구역이 더 바뀌지 않았습니다."].slice(0, 20);

  const report = verified.report;
  const summary = [
    `조립: ${used.map((u) => `${u.section === "experience" ? "경력" : u.section === "projects" ? "프로젝트" : u.section === "highlights" ? "성과" : u.section === "skills" ? "역량" : "기타"}${u.round < k ? "(유지)" : ""}`).join(" · ")} · 약 ${pages}쪽`,
    `사실 검증: 수치 확인 ${report.numbersFlagged.length}건 · 근거 없는 줄 ${report.dropped.filter((d) => d.reason !== "unknown_skill").length}개 제외 · 고침 ${report.corrected.length}건`,
  ];
  const over = budgetReport.filter((b) => b.over).length;
  if (over > 0) summary.push(`분량 예산을 넘은 구역 ${over}개(총괄 피드백으로 넘김)`);
  if (assembled.duplicates.length > 0) summary.push(`구역 사이 중복 ${assembled.duplicates.length}건`);
  if (topFallback) summary.push("요약은 작전 문장으로 대체했습니다");
  return {
    output: {
      round: k,
      draft: verified.draft,
      verify: report,
      duplicates: assembled.duplicates,
      budgetReport,
      pages,
      previewText: previewText(verified.draft.document, ctx.job.input.templateId),
      sectionsUsed: used,
      topFallback,
      unchanged,
    },
    summary,
    usage: meter.usage,
    model: meter.model,
  };
}
