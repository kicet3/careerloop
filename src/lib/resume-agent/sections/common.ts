/**
 * 구역 에이전트 공용(순수): 구역 경로 판정, 조각 ↔ 문서, 근거 범위, 분량 측정·자르기, keepPaths 복원, 줄 단위 바뀐 점.
 * 구역마다 sections/<id>.ts에 프롬프트 규칙·LLM 스키마·조각 변환·후처리를 둔다(레지스트리 sections/index.ts).
 */
import type { NodeLabel } from "@/lib/domain/graph";
import { emptyResumeDocument, toStoredHighlights, type ResumeDocument } from "@/lib/domain/resumes";
import { PROJECT_COUNT_MIN } from "@/lib/resumes/project-count";
import { compactKey } from "@/lib/skills/dictionary";
import { arrayAt, arraySlot, excludedRefs, itemPathOf, lineValue, linePaths, requirementsForLine, setLine, shiftCitations } from "../citations";
import type { WritingSection } from "../job-types";
import type { ChangeRecord, Citation, EvidenceItem, EvidencePack, ReviewIssue, SectionBrief, SectionBudget, SectionFragment } from "../schemas";

/** 근거 라벨 → 상세히 쓰는 구역(작전이 소유를 정하지 않은 근거·실행 중 재검색으로 들어온 근거도 이 규칙). */
export function ownerForLabel(label: NodeLabel): WritingSection {
  switch (label) {
    case "Project":
      return "projects";
    case "Education":
    case "Certification":
      return "extras";
    case "Skill":
      return "skills";
    default:
      return "experience"; // Company·Role·Experience·Achievement
  }
}

/** 구역이 갖는 문서 칸. */
export const SECTION_FIELDS: Record<WritingSection, readonly (keyof SectionFragment & keyof ResumeDocument)[]> = {
  experience: ["experience"],
  projects: ["projects"],
  highlights: ["highlights"],
  skills: ["skills"],
  extras: ["extras", "education", "certifications"],
};

const OWN_RE: Record<WritingSection, RegExp> = {
  experience: /^experience\[/,
  projects: /^projects\[/,
  highlights: /^highlights\[/,
  skills: /^skills\[/,
  extras: /^(extras|education|certifications)\[/,
};

/** 이 구역 경로인가(인용·keepPaths·지적 라우팅). */
export function ownsPath(section: WritingSection, path: string): boolean {
  return OWN_RE[section].test(path);
}

/** 문서 경로 → 구역(요약·상단은 'compose', 지원 동기·모르는 경로는 null). */
export function sectionOfPath(path: string): WritingSection | "compose" | null {
  if (path === "summary" || path.startsWith("basics.")) return "compose";
  for (const s of Object.keys(OWN_RE) as WritingSection[]) if (OWN_RE[s].test(path)) return s;
  return null;
}

/** 조각 → 그 칸만 채운 빈 문서. */
export function fragmentDoc(fragment: SectionFragment): ResumeDocument {
  const doc = emptyResumeDocument();
  for (const s of Object.values(SECTION_FIELDS).flat()) {
    const v = fragment[s];
    if (v === undefined) continue;
    // 핵심 성과 조각은 LLM 모양(예전 칸 context 없음) — 문서에는 저장 모양으로 둔다.
    (doc as Record<string, unknown>)[s] = s === "highlights" ? toStoredHighlights(fragment.highlights!) : structuredClone(v);
  }
  return doc;
}

/** 문서에서 이 구역 칸만 뽑는다. */
export function pickFragment(section: WritingSection, doc: ResumeDocument): SectionFragment {
  const out: SectionFragment = {};
  for (const f of SECTION_FIELDS[section]) {
    // 핵심 성과 조각은 LLM 모양(성과 요약 + 상세 성과 줄) — 예전 칸 context는 넣지 않는다.
    (out as Record<string, unknown>)[f] = f === "highlights" ? doc.highlights.map((h) => ({ title: h.title, details: [...h.details] })) : structuredClone(doc[f]);
  }
  return out;
}

/** 구역 글자 수(본문 텍스트 칸 합 — 날짜·링크 제외). 분량 예산 비교용. */
export function fragmentChars(fragment: SectionFragment): number {
  const n = (xs: readonly (string | undefined)[]) => xs.reduce((a, s) => a + (s ?? "").trim().length, 0);
  let c = 0;
  for (const e of fragment.experience ?? []) c += n([e.company, e.title, e.scope, ...e.bullets]);
  for (const p of fragment.projects ?? []) c += n([p.name, p.summary, p.problem, p.action, p.result, ...p.bullets]);
  for (const h of fragment.highlights ?? []) c += n([h.title, ...h.details]);
  for (const s of fragment.skills ?? []) c += n([s.category, s.items.join(", "), s.detail]);
  for (const x of fragment.extras ?? []) c += n([x.title, ...x.items]);
  for (const e of fragment.education ?? []) c += n([e.school, e.degree, e.major, e.note]);
  for (const x of fragment.certifications ?? []) c += n([x.name, x.issuer]);
  return c;
}

/** 배열 원소(항목·줄)를 지우고 인용 경로를 옮긴다. */
export function removeElement(doc: ResumeDocument, citations: Citation[], path: string): Citation[] {
  const slot = arraySlot(path);
  if (!slot) return citations;
  const arr = arrayAt(doc, slot.container);
  if (!Array.isArray(arr) || slot.index >= arr.length) return citations;
  arr.splice(slot.index, 1);
  return shiftCitations(citations, slot.container, slot.index, -1);
}

/** 이 항목(또는 그 줄)이 주 책임 요건을 다루는가. */
function coversPrimary(citations: readonly Citation[], path: string, primary: ReadonlySet<string>): boolean {
  if (primary.size === 0) return false;
  return citations.some((c) => (c.path === path || c.path.startsWith(`${path}.`) || c.path.startsWith(`${path}[`)) && c.requirementIds.some((r) => primary.has(r))) ||
    requirementsForLine(citations, path).some((r) => primary.has(r));
}

/** 대표 프로젝트 후보 수: 근거(pack)의 프로젝트(Project) 노드 중 작전이 빼지 않은 것(대표 프로젝트 2~3개 점검용). */
export function projectCandidateCount(pack: EvidencePack, brief: Pick<SectionBrief, "exclude" | "include">): number {
  const included = new Set(brief.include.projects.map((p) => p.ref));
  const excluded = new Set(brief.exclude.map((e) => e.ref).filter((r) => !included.has(r)));
  return pack.items.filter((i) => i.label === "Project" && !excluded.has(i.ref)).length;
}

/** 항목 목록(구역별): [컨테이너 경로, 항목 수, 항목의 줄 컨테이너]. */
function itemContainers(section: WritingSection, doc: ResumeDocument): { container: string; lines: ((i: number) => string | null) }[] {
  switch (section) {
    case "experience":
      return [{ container: "experience", lines: (i) => `experience[${i}].bullets` }];
    case "projects":
      return [{ container: "projects", lines: (i) => `projects[${i}].bullets` }];
    case "highlights":
      return [{ container: "highlights", lines: (i) => `highlights[${i}].details` }];
    case "skills":
      return [{ container: "skills", lines: () => null }];
    case "extras":
      return doc.extras.map((_, gi) => ({ container: `extras[${gi}].items`, lines: () => null }));
  }
}

/**
 * 분량 자르기(결정적): 항목 수 → 항목당 줄 → 글자 수 순서로, 뒤 항목·뒤 줄부터 지운다. 주 책임 요건을 다룬 줄·항목은 마지막까지 남긴다.
 * 항목은 하나 이상, 항목의 줄은 하나 이상 남긴다. 돌려주는 trimmed는 지운 원소 수.
 */
export function trimToBudget(
  section: WritingSection,
  fragment: SectionFragment,
  citations: readonly Citation[],
  budget: SectionBudget,
  primaryRequirementIds: readonly string[],
): { fragment: SectionFragment; citations: Citation[]; trimmed: number } {
  const doc = fragmentDoc(fragment);
  let cites = [...citations];
  const primary = new Set(primaryRequirementIds);
  let trimmed = 0;
  const lenOf = (container: string) => (arrayAt(doc, container) as unknown[] | null)?.length ?? 0;
  const dropLast = (container: string, keep: number): boolean => {
    const n = lenOf(container);
    if (n <= keep) return false;
    // 주 책임이 아닌 마지막 원소부터.
    for (let i = n - 1; i >= 0; i--) {
      if (!coversPrimary(cites, `${container}[${i}]`, primary)) {
        cites = removeElement(doc, cites, `${container}[${i}]`);
        trimmed++;
        return true;
      }
    }
    cites = removeElement(doc, cites, `${container}[${n - 1}]`);
    trimmed++;
    return true;
  };

  // 1) 항목 수.
  if (section !== "extras") {
    const container = itemContainers(section, doc)[0]!.container;
    while (budget.items > 0 && lenOf(container) > budget.items && dropLast(container, Math.max(1, budget.items)));
  } else {
    // 기타는 묶음 안 줄 수(linesPerItem)와 전체 줄 수(items).
    const total = () => doc.extras.reduce((n, x) => n + x.items.length, 0);
    for (let gi = 0; gi < doc.extras.length; gi++) while (budget.linesPerItem > 0 && doc.extras[gi]!.items.length > budget.linesPerItem && dropLast(`extras[${gi}].items`, 1));
    let guard = 40;
    while (budget.items > 0 && total() > budget.items && guard-- > 0) {
      const gi = [...doc.extras.keys()].reverse().find((g) => doc.extras[g]!.items.length > 1);
      if (gi === undefined || !dropLast(`extras[${gi}].items`, 1)) break;
    }
  }
  // 2) 항목당 줄(핵심 성과는 상세 성과 줄).
  if (budget.linesPerItem > 0 && (section === "experience" || section === "projects")) {
    const items = section === "experience" ? doc.experience : doc.projects;
    items.forEach((_, i) => {
      while (items[i]!.bullets.length > budget.linesPerItem && dropLast(`${section}[${i}].bullets`, Math.max(1, budget.linesPerItem)));
    });
  }
  if (budget.linesPerItem > 0 && section === "highlights") {
    doc.highlights.forEach((h, i) => {
      while (h.details.length > budget.linesPerItem && dropLast(`highlights[${i}].details`, Math.max(1, budget.linesPerItem)));
    });
  }
  // 3) 글자 수: 뒤 항목의 뒤 줄부터, 그다음 뒤 항목.
  let guard = 200;
  while (budget.chars > 0 && fragmentChars(pickFragment(section, doc)) > budget.chars && guard-- > 0) {
    let done = false;
    if (section === "experience" || section === "projects") {
      const items = section === "experience" ? doc.experience : doc.projects;
      for (let i = items.length - 1; i >= 0 && !done; i--) done = dropLast(`${section}[${i}].bullets`, 1);
      // 대표 프로젝트는 글자 수 때문에 2개 아래로 줄이지 않는다(기본 2~3개 — project-count.ts).
      if (!done) done = dropLast(section, section === "projects" ? PROJECT_COUNT_MIN : 1);
    } else if (section === "extras") {
      for (let gi = doc.extras.length - 1; gi >= 0 && !done; gi--) done = dropLast(`extras[${gi}].items`, 1);
    } else if (section === "highlights") {
      // 뒤 항목의 뒤 상세 성과 줄부터(항목마다 한 줄은 남긴다), 그다음 뒤 항목.
      for (let i = doc.highlights.length - 1; i >= 0 && !done; i--) done = dropLast(`highlights[${i}].details`, 1);
      if (!done) done = dropLast(section, 1);
    } else {
      done = dropLast(section, 1);
    }
    if (!done) break;
  }
  if (section === "extras") doc.extras = doc.extras.filter((x) => x.items.length > 0);
  return { fragment: pickFragment(section, doc), citations: cites, trimmed };
}

/** keepPaths의 줄이 바뀌었으면 이전 값(과 인용)으로 되돌린다. 이 구역 경로·두 문서에 모두 있는 줄만. */
export function restoreKeepPaths(
  section: WritingSection,
  prev: { fragment: SectionFragment; citations: readonly Citation[] },
  next: { fragment: SectionFragment; citations: Citation[] },
  keepPaths: readonly string[],
): { fragment: SectionFragment; citations: Citation[]; restored: string[] } {
  const prevDoc = fragmentDoc(prev.fragment);
  const doc = fragmentDoc(next.fragment);
  let cites = [...next.citations];
  const restored: string[] = [];
  for (const p of keepPaths) {
    if (!ownsPath(section, p)) continue;
    const old = lineValue(prevDoc, p);
    const now = lineValue(doc, p);
    if (old === null || now === null || old === now) continue;
    setLine(doc, p, old);
    cites = [...cites.filter((c) => c.path !== p), ...prev.citations.filter((c) => c.path === p)];
    restored.push(p);
  }
  return { fragment: pickFragment(section, doc), citations: cites, restored };
}

/** 이전 조각과 새 조각의 줄 단위 비교 → 리포트 '바뀐 점'. */
export function lineChanges(
  section: WritingSection,
  round: number,
  prev: SectionFragment,
  next: SectionFragment,
  link: { issueIds: readonly string[]; reviewers: readonly string[] },
): ChangeRecord[] {
  const a = new Map(linePaths(fragmentDoc(prev)).filter((l) => ownsPath(section, l.path) && l.value.trim()).map((l) => [l.path as string, l.value]));
  const b = new Map(linePaths(fragmentDoc(next)).filter((l) => ownsPath(section, l.path) && l.value.trim()).map((l) => [l.path as string, l.value]));
  const out: ChangeRecord[] = [];
  const base = { round, issueIds: [...link.issueIds], reviewers: [...link.reviewers] };
  // 값 기준 비교: 새로 생긴 줄 → 같은 자리에서 사라진 줄이 있으면 replace, 없으면 insert. 남은 사라진 줄 → remove.
  const prevValues = new Set(a.values());
  const nextValues = new Set(b.values());
  const removed = new Map([...a].filter(([, v]) => !nextValues.has(v)));
  for (const [path, value] of b) {
    if (prevValues.has(value)) continue;
    const before = removed.get(path);
    if (before !== undefined) {
      removed.delete(path);
      out.push({ ...base, op: "replace", path, before, after: value });
    } else out.push({ ...base, op: "insert", path, before: null, after: value });
  }
  for (const [path, value] of removed) out.push({ ...base, op: "remove", path, before: value, after: null });
  const order = (f: SectionFragment) => [...linePaths(fragmentDoc(f))].filter((l) => ownsPath(section, l.path)).map((l) => l.value).join("\n");
  if (out.length === 0 && order(prev) !== order(next)) out.push({ ...base, op: "reorder", path: section, before: null, after: null });
  return out.slice(0, 40);
}

/** 정규화한 조각이 같은가(공백 차이 무시). */
export function sameFragment(a: SectionFragment, b: SectionFragment): boolean {
  const norm = (f: SectionFragment) => JSON.stringify(f).replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

/** 거의 같은 문장(compact 비교 90% 이상). */
export function nearDuplicate(a: string, b: string): boolean {
  const x = compactKey(a);
  const y = compactKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short) && short.length / long.length >= 0.9) return true;
  // 글자 2-gram Dice 계수.
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(x);
  const gb = grams(y);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(1, x.length - 1 + (y.length - 1));
  return (2 * inter) / total >= 0.9;
}

/**
 * 구역 근거 범위(전체 줄 / 참고 / 이름만):
 *   - full: 배정 refs·추가 refs(재작성 지적 관련)·구역 뼈대(경력의 회사·직무, 기타의 학력·자격, 역량의 기술) — 지시서의 주 근거.
 *   - reference: 이 구역 소유지만 지시서가 고르지 않은 근거(전체 줄, '필요할 때만'). 작전 소유가 없는 근거(실행 중 재검색으로
 *     들어온 근거)는 라벨 규칙(ownerForLabel)의 구역 소유로 보고 그 구역의 full에 넣는다(다시 쓰기에서 바로 쓰게).
 *   - nameOnly: 다른 구역 소유 근거(이름·기간만).
 * 작전이 뺀 근거(excludedRefs)는 넣지 않는다(추가 refs는 예외).
 */
export function sectionEvidence(
  pack: EvidencePack,
  brief: SectionBrief,
  section: WritingSection,
  extraRefs: ReadonlySet<string> = new Set(),
): { full: EvidenceItem[]; reference: EvidenceItem[]; nameOnly: EvidenceItem[] } {
  const excluded = excludedRefs(brief);
  const owner = new Map(brief.evidenceOwner.map((o) => [o.ref, o.section]));
  const assignment = brief.assignments.find((a) => a.section === section);
  const mine = new Set<string>([...(assignment?.refs ?? []), ...extraRefs]);
  const skeleton = (i: EvidenceItem) =>
    (section === "experience" && (i.label === "Role" || i.label === "Company")) ||
    (section === "extras" && (i.label === "Education" || i.label === "Certification")) ||
    (section === "skills" && i.label === "Skill");
  const full: EvidenceItem[] = [];
  const reference: EvidenceItem[] = [];
  const nameOnly: EvidenceItem[] = [];
  for (const i of pack.items) {
    if (excluded.has(i.ref) && !extraRefs.has(i.ref)) continue;
    // 기술 노드는 직무 역량 구역만 따로 받는다(다른 구역은 근거 줄의 '기술:'로 본다).
    if (i.label === "Skill" && section !== "skills" && !mine.has(i.ref)) continue;
    const o = owner.get(i.ref);
    if (mine.has(i.ref) || skeleton(i)) full.push(i);
    else if (o === undefined) (ownerForLabel(i.label) === section ? full : nameOnly).push(i);
    else if (o === section) reference.push(i);
    else nameOnly.push(i);
  }
  return { full, reference, nameOnly };
}

/** 피드백 키워드·요건과 관련된 근거 ref(재작성 라운드에서 다른 구역 소유여도 전체 줄로 보여 준다). */
export function feedbackRefs(pack: EvidencePack, feedback: { keywords: readonly string[]; requirementIds: readonly string[] } | null): Set<string> {
  const out = new Set<string>();
  if (!feedback) return out;
  const req = new Set(feedback.requirementIds);
  for (const b of pack.byRequirement) if (req.has(b.requirementId)) b.refs.forEach((r) => out.add(r));
  const kws = feedback.keywords.map(compactKey).filter((k) => k.length >= 2);
  for (const i of pack.items) {
    if (i.label === "Skill") continue;
    const text = compactKey(`${i.name} ${i.text} ${i.skills.join(" ")}`);
    if (kws.some((k) => text.includes(k))) out.add(i.ref);
  }
  return out;
}

/** 지적 id → 심사위원(바뀐 점의 reviewers). */
export function reviewersFor(issueIds: readonly string[], issues: readonly ReviewIssue[]): string[] {
  const by = new Map(issues.map((i) => [i.id, i.reviewer]));
  return [...new Set(issueIds.map((id) => by.get(id)).filter((x): x is ReviewIssue["reviewer"] => !!x))];
}

export { itemPathOf };

/** 사용자에게 보일 문장의 근거 ref(E12)를 근거 이름으로 바꾼다(없는 ref는 지운다). 노드 id는 쓰지 않는다. */
export function humanizeRefs(text: string, pack: Pick<EvidencePack, "items"> | null): string {
  const byRef = new Map((pack?.items ?? []).map((i) => [i.ref, i.name]));
  return text
    .replace(/\bE\d{1,3}\b/g, (ref) => {
      const name = byRef.get(ref);
      return name ? `'${name.slice(0, 40)}'` : "";
    })
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
