/**
 * 사실 검증(결정적, 순수) — write_top·revise 끝에서 실행. 모든 서술 줄은 인용한 근거 노드에 있는 사실만 담아야 한다.
 *   1) 인용 없는 줄 제거(항목 인용 상속). 제거 비율이 MAX_DROP_RATIO를 넘으면 지우지 않고 재작성 신호(needsRetry)만 돌려준다.
 *   0) 전략이 뺀 근거(plan.exclude)만 인용한 줄·항목은 지운다(reason 'excluded' — 재작성 비율에는 세지 않는다).
 *   2) 근거에 없는 숫자 → [ADD: 수치 확인 — 원문](포트폴리오와 같은 unverifiedNumbers 규칙). 여러 문장 칸은 그 숫자가 든 문장만 감싸고,
 *      칸 글자 상한(maxCharsFor) 안에서 닫는 괄호가 남게 자른다. 기간(연·월)과 기간에서 계산한 개월·연수·총 경력은 근거 숫자로 본다.
 *   3) 기술명(projects[].techs, skills[].items)은 그래프 기술 또는 인용 근거에 있어야 한다.
 *   4) 경력 뼈대(회사·직무·기간)는 인용한 직무 노드 값으로, 프로젝트 기간·학력 기간·자격 취득일은 인용한 노드 값으로 고친다(사실 원천은 그래프).
 *      총 경력(basics.totalExperience)은 직무 기간으로 서버가 계산한다. 프로젝트 팀 구성·역할의 숫자·주도 표현, 학위·전공·발급처도 근거와 대조한다.
 *   5) pack 밖 ref는 버린다(parseCitations가 먼저 거른다).
 *   6·7) gap 요건을 충족처럼 인용한 줄, 근거에 없는 주도·최상급 표현 → riskyClaims(고치지 않고 revise로 넘긴다).
 */
import type { ResumeDocument } from "@/lib/domain/resumes";
import { compactKey, skillKey } from "@/lib/skills/dictionary";
import { stripPlaceholders, unverifiedNumbers } from "@/lib/text/numbers";
import { evidenceSourceText } from "./evidence-text";
import { arraySlot, excludedRefs, itemPathOf, linePaths, refsForLine, requirementsForLine, shiftCitations } from "./citations";
import { maxCharsFor } from "./patch";
import type { AgentDraft, Citation, EvidenceItem, EvidencePack, ResumeAgentPlan, VerifyReport } from "./schemas";

export const MAX_DROP_RATIO = 0.25;

/** 상단 칸(write_top이 쓰는 곳): 요약·basics·핵심 성과·기술. */
export const isTopPath = (p: string): boolean => p === "summary" || p.startsWith("basics.") || /^(highlights|skills)\[\d+\]/.test(p);

const ADD_ONLY = /^\s*(\[ADD:[^\]]*\]\s*)+$/;
const OWNERSHIP_RE = /(주도|리드|총괄|단독)/;
const SUPERLATIVE_RE = /(최초|유일)/;
const NO_NUMBER_CHECK = new Set(["basics.totalExperience"]);

const evidenceText = evidenceSourceText;

const FLAG_PREFIX = "[ADD: 수치 확인 — ";

/** 줄 전체를 자리표시로(기본 수치 확인). 칸 상한(max)을 넘으면 본문을 줄이고 '…'를 붙여 닫는 괄호를 남긴다. */
export function numberFlag(text: string, max: number, prefix = FLAG_PREFIX): string {
  const body = text.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  const full = `${prefix}${body}]`;
  if (full.length <= max) return full;
  const room = Math.max(0, max - prefix.length - 2);
  return `${prefix}${body.slice(0, room).trimEnd()}…]`;
}

/** 문장 단위로 나눈다([ADD: …] 안은 나누지 않는다). 조각을 이으면 원문과 같다. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    const boundary = ch === "\n" || (/[.!?。]/.test(ch) && i + 1 < text.length && /\s/.test(text[i + 1]!));
    if (!boundary) continue;
    let end = i + 1;
    while (end < text.length && /\s/.test(text[end]!)) end++;
    out.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/**
 * 근거에 없는 숫자가 든 칸을 자리표시로 바꾼다. 여러 문장이면 그 숫자가 든 문장만 감싼다(요약 한 줄의 숫자 하나가 요약 전체를 지우지 않게).
 * 결과가 칸 상한을 넘으면 줄 전체를 상한 안의 자리표시로.
 */
export function flagUnverified(value: string, badNumbers: (text: string) => string[], max: number): string {
  const pieces = splitSentences(value);
  if (pieces.length > 1) {
    const out = pieces
      .map((p) => {
        const core = p.trim();
        if (!core || badNumbers(core).length === 0) return p;
        const lead = /^\s*/.exec(p)![0];
        const tail = p.slice(lead.length + core.length);
        return `${lead}${FLAG_PREFIX}${core.replace(/[[\]]/g, "")}]${tail}`;
      })
      .join("");
    if (out.length <= max) return out;
  }
  return numberFlag(value, max);
}

type Ym = { y: number; m: number | null };

function parseYm(s: string | null | undefined, asOf: Date): Ym | null {
  if (!s) return null;
  if (/현재/.test(s)) return { y: asOf.getFullYear(), m: asOf.getMonth() + 1 };
  const m = /(\d{4})(?:[.\-/](\d{1,2}))?/.exec(s);
  if (!m) return null;
  const month = m[2] ? Number(m[2]) : null;
  return { y: Number(m[1]), m: month && month >= 1 && month <= 12 ? month : null };
}

/** 항목의 [시작, 끝] (facts 우선, 없으면 period "2022.03 ~ 현재"). */
function spanOf(item: EvidenceItem, asOf: Date): [Ym | null, Ym | null] {
  if (item.facts && (item.facts.startDate || item.facts.endDate || item.facts.current)) {
    return [parseYm(item.facts.startDate, asOf), item.facts.current ? parseYm("현재", asOf) : parseYm(item.facts.endDate, asOf)];
  }
  const [a, b] = item.period.split("~");
  return [parseYm(a, asOf), parseYm(b ?? null, asOf)];
}

const monthIndex = (v: Ym) => v.y * 12 + (v.m! - 1);

/** 기간 사실: 연도·연월 표기(근거 숫자로 본다)와, 단위가 붙어야만 인정하는 월·개월 수·연수. */
interface PeriodFacts {
  /** 근거 원문에 더할 토큰("2022", "2022.03", "2022.3"). */
  tokens: Set<string>;
  /** "3월"의 3. */
  months: Set<number>;
  /** "10개월"의 10. */
  durMonths: Set<number>;
  /** "1년", "5년 차"의 1·5. */
  durYears: Set<number>;
}

function emptyFacts(): PeriodFacts {
  return { tokens: new Set(), months: new Set(), durMonths: new Set(), durYears: new Set() };
}

/** 인용한 근거의 기간에서 나오는 숫자. 월·기간 수는 단위(월·개월·년)가 붙을 때만 인정한다(맨숫자 '3'이 달 때문에 통과하지 않게). */
function periodFacts(items: readonly EvidenceItem[], asOf: Date): PeriodFacts {
  const f = emptyFacts();
  for (const it of items) {
    const [a, b] = spanOf(it, asOf);
    for (const v of [a, b]) {
      if (!v) continue;
      f.tokens.add(String(v.y));
      if (v.m) {
        f.months.add(v.m);
        f.tokens.add(`${v.y}.${String(v.m).padStart(2, "0")}`);
        f.tokens.add(`${v.y}.${v.m}`);
      }
    }
    if (a?.m && b?.m) {
      const months = monthIndex(b) - monthIndex(a) + 1;
      if (months > 0) {
        for (const n of [months, months - 1]) if (n > 0) f.durMonths.add(n);
        for (const n of [Math.floor(months / 12), Math.ceil(months / 12)]) if (n > 0) f.durYears.add(n);
        if (months % 12 > 0) f.durMonths.add(months % 12);
      }
    }
  }
  return f;
}

/** 총 경력(개월)에서 나오는 기간 수: N년(·N+1년 차)·M개월·총 개월. */
function addTenure(f: PeriodFacts, total: number | null): PeriodFacts {
  if (total === null || total <= 0) return f;
  const y = Math.floor(total / 12);
  const out: PeriodFacts = { tokens: new Set(f.tokens), months: new Set(f.months), durMonths: new Set(f.durMonths), durYears: new Set(f.durYears) };
  for (const n of [y, y + 1, Math.ceil(total / 12)]) if (n > 0) out.durYears.add(n);
  for (const n of [total, total % 12]) if (n > 0) out.durMonths.add(n);
  return out;
}

/** 근거에 없는 숫자(기간 사실로 설명되는 '2022년 3월'·'10개월간'·'5년 차'는 뺀다). */
function badNumbersFor(text: string, source: string, f: PeriodFacts): string[] {
  const t = stripPlaceholders(text)
    .replace(/(\d{1,2})\s*월/g, (m, n: string) => (f.months.has(Number(n)) ? " " : m))
    .replace(/(\d{1,3})\s*개월/g, (m, n: string) => (f.durMonths.has(Number(n)) ? " " : m))
    .replace(/(\d{1,2})\s*년/g, (m, n: string) => (f.durYears.has(Number(n)) ? " " : m));
  return unverifiedNumbers(t, `${source}\n${[...f.tokens].join(" ")}`);
}

/** 직무(Role) 기간의 합(겹치는 달은 한 번) → 총 개월. 시작 연·월이 있는 직무가 없으면 null. */
function tenureMonths(pack: EvidencePack, asOf: Date): number | null {
  const months = new Set<number>();
  let any = false;
  for (const it of pack.items) {
    if (it.label !== "Role") continue;
    const [a, b] = spanOf(it, asOf);
    if (!a?.m) continue;
    const end = b?.m ? b : null;
    if (!end) continue;
    any = true;
    for (let i = monthIndex(a); i <= monthIndex(end); i++) months.add(i);
  }
  return any ? months.size : null;
}

export function formatTenure(months: number): string {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y > 0 ? `${y}년` : "", m > 0 ? `${m}개월` : ""].filter(Boolean).join(" ") || "1개월 미만";
}


function itemsFor(pack: EvidencePack, refs: readonly string[]): EvidenceItem[] {
  const set = new Set(refs);
  return pack.items.filter((i) => set.has(i.ref));
}

/** 경력·학력·자격 항목에 인용이 없을 때, 이름이 pack의 노드와 같으면 그 노드를 항목 인용으로 단다(뼈대 사실만). */
function autoCiteSkeleton(doc: ResumeDocument, citations: Citation[], pack: EvidencePack): Citation[] {
  const out = [...citations];
  const has = (p: string) => out.some((c) => c.path === p);
  const find = (label: EvidenceItem["label"], name: string) => {
    const key = compactKey(name);
    return key ? pack.items.find((i) => i.label === label && compactKey(i.name) === key) : undefined;
  };
  doc.experience.forEach((e, i) => {
    const p = `experience[${i}]`;
    if (has(p)) return;
    const role = pack.items.find((it) => it.label === "Role" && compactKey(it.name) === compactKey(e.title) && (!it.facts?.company || compactKey(it.facts.company) === compactKey(e.company)));
    const company = find("Company", e.company);
    const refs = [role?.ref, company?.ref].filter((r): r is string => !!r);
    if (role) out.push({ path: p, refs, requirementIds: [] });
  });
  doc.education.forEach((e, i) => {
    const hit = find("Education", e.school);
    if (hit && !has(`education[${i}]`)) out.push({ path: `education[${i}]`, refs: [hit.ref], requirementIds: [] });
  });
  doc.certifications.forEach((c, i) => {
    const hit = find("Certification", c.name);
    if (hit && !has(`certifications[${i}]`)) out.push({ path: `certifications[${i}]`, refs: [hit.ref], requirementIds: [] });
  });
  return out;
}

/** 항목(경력·프로젝트·핵심 성과·학력·자격)에 인용이 하나도 없으면(항목·줄 모두) 항목째 지울 대상. */
function uncitedItems(doc: ResumeDocument, citations: readonly Citation[]): string[] {
  const out: string[] = [];
  const cited = (prefix: string) => citations.some((c) => c.path === prefix || c.path.startsWith(`${prefix}.`));
  (["experience", "projects", "highlights", "education", "certifications"] as const).forEach((sec) => {
    doc[sec].forEach((_, i) => {
      if (!cited(`${sec}[${i}]`)) out.push(`${sec}[${i}]`);
    });
  });
  return out;
}

const itemText = (doc: ResumeDocument, path: string): string => {
  const m = /^(\w+)\[(\d+)\]$/.exec(path);
  if (!m) return "";
  const v = (doc as unknown as Record<string, unknown[]>)[m[1]!]?.[Number(m[2])] as Record<string, unknown> | undefined;
  if (!v) return "";
  const first = [v.name, v.company, v.title, v.school].find((x) => typeof x === "string" && x.trim());
  return String(first ?? "").slice(0, 120);
};

function removeArrayElement(doc: ResumeDocument, citations: Citation[], path: string): Citation[] {
  const slot = arraySlot(path);
  if (!slot) return citations;
  const segs = slot.container.split(".");
  let arr: unknown = doc;
  for (const s of segs) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(s)!;
    arr = (arr as Record<string, unknown>)[m[1]!];
    if (m[2] !== undefined) arr = (arr as unknown[])[Number(m[2])];
  }
  if (!Array.isArray(arr) || slot.index >= arr.length) return citations;
  arr.splice(slot.index, 1);
  return shiftCitations(citations, slot.container, slot.index, -1);
}

export interface VerifyResult {
  draft: AgentDraft;
  report: VerifyReport;
  /** 인용 없는 줄이 너무 많아 지우지 않았다 — 같은 단계에서 한 번 다시 쓰게 한다(allowRetry일 때만). */
  needsRetry: boolean;
  /** 인용 없는 줄 경로(재작성 프롬프트에 붙일 목록). */
  uncitedPaths: string[];
}

export function verifyDraft(
  input: AgentDraft,
  pack: EvidencePack,
  plan: (Pick<ResumeAgentPlan, "requirementMap"> & Partial<Pick<ResumeAgentPlan, "include" | "exclude" | "keywordPlan">>) | null,
  opts: {
    allowRetry: boolean;
    retried?: boolean;
    invalidRefPaths?: readonly string[];
    asOf?: Date;
    /** 재작성 판정에 셀 경로(기본 전체). write_top은 상단 칸만 — 본문 공백은 write_body가 이미 다뤘고 상단 작성기는 본문을 못 고친다. */
    retryScope?: (path: string) => boolean;
  },
): VerifyResult {
  // 재직 중 기간("현재")의 끝. 순수 함수로 쓰려면 asOf를 준다.
  const asOf = opts.asOf ?? new Date();
  const draft: AgentDraft = structuredClone(input);
  const doc = draft.document;
  const packRefs = new Set(pack.items.map((i) => i.ref));
  const report: VerifyReport = { numbersFlagged: [], dropped: [], corrected: [], riskyClaims: [], retriedForCitations: opts.retried ?? false };
  const invalid = new Set(opts.invalidRefPaths ?? []);

  // 5) pack 밖 ref 제거.
  let citations = draft.citations
    .map((c) => ({ ...c, refs: c.refs.filter((r) => packRefs.has(r)) }))
    .filter((c) => c.refs.length > 0);
  citations = autoCiteSkeleton(doc, citations, pack);

  // 0) 전략이 뺀 근거(plan.exclude)는 인용에서 뺀다 → 그 근거만 인용한 줄·항목은 아래 1)에서 'excluded'로 지워진다.
  const excluded = excludedRefs(plan);
  const excludedPaths = new Set<string>();
  if (excluded.size > 0) {
    for (const c of citations) if (c.refs.every((r) => excluded.has(r))) excludedPaths.add(c.path);
    citations = citations.map((c) => ({ ...c, refs: c.refs.filter((r) => !excluded.has(r)) })).filter((c) => c.refs.length > 0);
  }
  const reasonOf = (p: string): VerifyReport["dropped"][number]["reason"] =>
    invalid.has(p) ? "invalid_ref" : excludedPaths.has(p) || excludedPaths.has(itemPathOf(p)) ? "excluded" : "uncited";

  // 1) 인용 없는 줄·항목. 재작성 비율은 '인용 없음'만 센다(전략이 뺀 것은 다시 써도 넣지 않는다).
  const lines = linePaths(doc).filter((l) => l.value.trim() && !ADD_ONLY.test(l.value));
  const uncitedLines = lines.filter((l) => refsForLine(citations, l.path).length === 0);
  const deadItems = uncitedItems(doc, citations);
  const deadItemSet = new Set(deadItems);
  const dropPaths = new Set([...uncitedLines.map((l) => l.path), ...lines.filter((l) => deadItemSet.has(itemPathOf(l.path))).map((l) => l.path)]);
  const inScope = opts.retryScope ?? (() => true);
  const scopedLines = lines.filter((l) => inScope(l.path));
  const dropCount = [...dropPaths].filter((p) => inScope(p) && reasonOf(p) !== "excluded").length;
  const ratio = scopedLines.length > 0 ? dropCount / scopedLines.length : 0;
  const uncitedPaths = [...new Set([...deadItems, ...uncitedLines.map((l) => l.path)])].filter((p) => inScope(p) && reasonOf(p) !== "excluded");
  if (opts.allowRetry && ratio > MAX_DROP_RATIO && dropCount > 0) {
    return { draft: input, report, needsRetry: true, uncitedPaths };
  }
  // 줄부터 지운다(항목 안 배열 원소는 뒤에서부터 — 인덱스가 어긋나지 않게), 그다음 항목(뒤에서부터).
  const scalarDrops = uncitedLines.filter((l) => !deadItemSet.has(itemPathOf(l.path)));
  const arrayDrops = scalarDrops.filter((l) => /\]$/.test(l.path)).sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true }));
  for (const l of scalarDrops.filter((x) => !/\]$/.test(x.path))) {
    report.dropped.push({ path: l.path, text: l.value.slice(0, 300), reason: reasonOf(l.path) });
    setField(doc, l.path, "");
  }
  for (const l of arrayDrops) {
    report.dropped.push({ path: l.path, text: l.value.slice(0, 300), reason: reasonOf(l.path) });
    citations = removeArrayElement(doc, citations, l.path);
  }
  for (const p of [...deadItems].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    report.dropped.push({ path: p, text: itemText(doc, p), reason: reasonOf(p) });
    citations = removeArrayElement(doc, citations, p);
  }
  const nUncited = report.dropped.filter((d) => d.reason !== "excluded").length;
  const nExcluded = report.dropped.length - nUncited;
  if (nUncited > 0) draft.notes = [...draft.notes, `근거를 찾지 못해 ${nUncited}개 줄·항목을 뺐습니다.`].slice(0, 20);
  if (nExcluded > 0) draft.notes = [...draft.notes, `작성 전략에서 제외한 근거만 쓴 ${nExcluded}개 줄·항목을 뺐습니다.`].slice(0, 20);

  // 4) 경력 뼈대 보정.
  doc.experience.forEach((e, i) => {
    const refs = refsForLine(citations, `experience[${i}].scope`);
    const role = itemsFor(pack, refs).find((it) => it.label === "Role");
    if (!role?.facts) return;
    const fix = (field: "company" | "title" | "startDate" | "endDate", value: string | null) => {
      if (!value) return;
      if (e[field].trim() !== value) {
        report.corrected.push({ path: `experience[${i}].${field}`, before: e[field], after: value });
        e[field] = value;
      }
    };
    fix("title", role.name);
    fix("company", role.facts.company);
    fix("startDate", role.facts.startDate || null);
    fix("endDate", role.facts.current ? "현재" : role.facts.endDate || null);
  });

  // 4') 프로젝트·학력·자격 뼈대: 기간·취득일은 인용한 노드 값으로(노드에 없으면 비운다), 짧은 사실 칸은 근거와 대조한다.
  const correct = (path: string, before: string, after: string): string => {
    if (before.trim() === after.trim()) return before;
    report.corrected.push({ path, before, after });
    return after;
  };
  const missingFacts: string[] = [];
  doc.projects.forEach((p, i) => {
    const its = itemsFor(pack, refsForLine(citations, `projects[${i}].summary`));
    const node = its.find((it) => (it.label === "Project" || it.label === "Experience") && it.facts);
    if (node?.facts) {
      p.startDate = correct(`projects[${i}].startDate`, p.startDate, node.facts.startDate);
      p.endDate = correct(`projects[${i}].endDate`, p.endDate, node.facts.current ? "현재" : node.facts.endDate);
    }
    const src = evidenceText(its);
    const facts = periodFacts(its, asOf);
    for (const k of ["team", "role"] as const) {
      const v = p[k];
      if (!v.trim() || ADD_ONLY.test(v)) continue;
      const bad = badNumbersFor(v, src, facts);
      const own = k === "role" ? OWNERSHIP_RE.exec(v) : null;
      const ownBad = !!own && !src.includes(own[1]!) && !/(lead|리더|팀장|PM)/i.test(src);
      if (bad.length === 0 && !ownBad) continue;
      if (bad.length > 0) report.numbersFlagged.push({ path: `projects[${i}].${k}`, numbers: bad });
      p[k] = correct(`projects[${i}].${k}`, v, numberFlag(v, 120, bad.length > 0 ? FLAG_PREFIX : "[ADD: 역할 확인 — "));
      missingFacts.push(`프로젝트 '${p.name.slice(0, 40)}'의 ${k === "team" ? "팀 구성" : "역할"}('${v.slice(0, 40)}')이 경험 그래프에 없어 확인이 필요합니다.`);
    }
  });
  const supported = (value: string, its: readonly EvidenceItem[]) => {
    const key = compactKey(value);
    return !key || compactKey(evidenceText(its)).includes(key);
  };
  doc.education.forEach((e, i) => {
    const its = itemsFor(pack, refsForLine(citations, `education[${i}].note`)).filter((it) => it.label === "Education");
    const node = its.find((it) => it.facts);
    if (!node?.facts) return;
    e.startDate = correct(`education[${i}].startDate`, e.startDate, node.facts.startDate);
    e.endDate = correct(`education[${i}].endDate`, e.endDate, node.facts.current ? "현재" : node.facts.endDate);
    if (!supported(e.degree, its)) e.degree = correct(`education[${i}].degree`, e.degree, "");
    if (!supported(e.major, its)) e.major = correct(`education[${i}].major`, e.major, "");
  });
  doc.certifications.forEach((c, i) => {
    const its = itemsFor(pack, refsForLine(citations, `certifications[${i}]`)).filter((it) => it.label === "Certification");
    const node = its.find((it) => it.facts);
    if (!node?.facts) return;
    c.date = correct(`certifications[${i}].date`, c.date, node.facts.startDate);
    if (!supported(c.issuer, its)) c.issuer = correct(`certifications[${i}].issuer`, c.issuer, "");
  });

  // 총 경력은 직무 기간으로 서버가 계산한다(모델 값은 쓰지 않는다). 계산할 수 없으면 비운다.
  const tenure = tenureMonths(pack, asOf);
  const totalExperience = tenure === null ? (ADD_ONLY.test(doc.basics.totalExperience) ? doc.basics.totalExperience : "") : formatTenure(tenure);
  doc.basics.totalExperience = correct("basics.totalExperience", doc.basics.totalExperience, totalExperience);


  // 2) 수치.
  const missing = [...draft.missingInfo, ...missingFacts];
  for (const l of linePaths(doc)) {
    if (!l.value.trim() || NO_NUMBER_CHECK.has(l.path)) continue;
    const its = itemsFor(pack, refsForLine(citations, l.path));
    // 기간 숫자(연·월·개월 수)와, 요약 영역이면 총 경력 숫자('5년 차')도 근거로 본다.
    const summaryArea = itemPathOf(l.path) === "summary";
    const source = evidenceText(its);
    const facts = summaryArea ? addTenure(periodFacts(its, asOf), tenure) : periodFacts(its, asOf);
    const badOf = (text: string) => badNumbersFor(text, source, facts);
    const bad = badOf(l.value);
    if (bad.length === 0) continue;
    report.numbersFlagged.push({ path: l.path, numbers: bad });
    setField(doc, l.path, flagUnverified(l.value, badOf, maxCharsFor(l.path)));
    missing.push(`'${l.value.slice(0, 60)}' — 경험 그래프에 없는 수치(${bad.join(", ")})라 확인이 필요합니다. 맞다면 그래프에도 적어 주세요.`);
  }
  draft.missingInfo = [...new Set(missing)].slice(0, 30);

  // 3) 기술명.
  const known = new Set(pack.skillKeys);
  const allowedFor = (refs: readonly string[]) => {
    const its = itemsFor(pack, refs);
    const keys = new Set(its.flatMap((i) => i.skills.map(skillKey)));
    const text = compactKey(evidenceText(its));
    return (name: string) => known.has(skillKey(name)) || keys.has(skillKey(name)) || (compactKey(name).length >= 2 && text.includes(compactKey(name)));
  };
  doc.projects.forEach((p, i) => {
    const ok = allowedFor(refsForLine(citations, `projects[${i}].summary`));
    p.techs = p.techs.filter((t) => {
      if (!t.trim() || ok(t)) return true;
      report.dropped.push({ path: `projects[${i}].techs`, text: t, reason: "unknown_skill" });
      return false;
    });
  });
  doc.skills.forEach((s, i) => {
    const ok = allowedFor(refsForLine(citations, `skills[${i}].detail`));
    s.items = s.items.filter((t) => {
      if (!t.trim() || ok(t)) return true;
      report.dropped.push({ path: `skills[${i}].items`, text: t, reason: "unknown_skill" });
      return false;
    });
  });

  // 6) gap 요건을 인용한 줄, 7) 근거에 없는 주도·최상급 표현.
  const gaps = new Set((plan?.requirementMap ?? []).filter((r) => r.status === "gap").map((r) => r.requirementId));
  for (const l of linePaths(doc)) {
    if (!l.value.trim() || ADD_ONLY.test(l.value)) continue;
    const reqs = requirementsForLine(citations, l.path);
    if (reqs.some((r) => gaps.has(r)) && citations.some((c) => c.path === l.path)) {
      report.riskyClaims.push({ path: l.path, text: l.value.slice(0, 300), reason: "gap_requirement" });
      continue;
    }
    const src = evidenceText(itemsFor(pack, refsForLine(citations, l.path)));
    const own = OWNERSHIP_RE.exec(l.value);
    if (own && !src.includes(own[1]!) && !/(lead|리더|팀장|PM)/i.test(src)) {
      report.riskyClaims.push({ path: l.path, text: l.value.slice(0, 300), reason: "ownership" });
      continue;
    }
    const sup = SUPERLATIVE_RE.exec(l.value);
    if (sup && !src.includes(sup[1]!)) report.riskyClaims.push({ path: l.path, text: l.value.slice(0, 300), reason: "superlative" });
  }
  report.riskyClaims = report.riskyClaims.slice(0, 40);

  draft.citations = citations.slice(0, 200);
  return { draft, report, needsRetry: false, uncitedPaths };
}

function setField(doc: ResumeDocument, path: string, value: string): void {
  const segs = path.split(".");
  let cur: unknown = doc;
  for (const [i, s] of segs.entries()) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(s);
    if (!m) return;
    const last = i === segs.length - 1;
    const obj = cur as Record<string, unknown>;
    if (last) {
      if (m[2] === undefined) obj[m[1]!] = value;
      else (obj[m[1]!] as unknown[])[Number(m[2])] = value;
      return;
    }
    cur = obj[m[1]!];
    if (m[2] !== undefined) cur = (cur as unknown[])[Number(m[2])];
  }
}

/** 경력·프로젝트가 모두 비었는가(검증 뒤 단계 실패 판정). */
export function draftIsEmpty(doc: ResumeDocument): boolean {
  return doc.experience.length === 0 && doc.projects.length === 0;
}
