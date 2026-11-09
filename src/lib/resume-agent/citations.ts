/**
 * 문서 경로·인용(순수). 경로 문법은 schemas.ts의 DOC_PATH_RE(줄)·ITEM_PATH_RE(항목).
 * - 줄의 근거 = 그 줄 경로의 인용 ∪ 가장 가까운 상위 항목 인용(refsForLine).
 * - 모델이 낸 인용은 parseCitations로 거른다: 문법·실제 존재하는 경로·pack에 있는 ref만 남긴다.
 * - 심사 quote → 문서 경로 역매핑(locateQuote).
 */
import type { ResumeDocument } from "@/lib/domain/resumes";
import { normalizeForQuote, verifyQuote } from "@/lib/panel/quotes";
import { DOC_PATH_RE, ITEM_PATH_RE, type Citation, type DocPath } from "./schemas";

type Seg = { key: string; index: number | null };

/** "experience[0].bullets[1]" → [{experience,0},{bullets,1}] */
export function parsePath(path: string): Seg[] | null {
  const segs: Seg[] = [];
  for (const part of path.split(".")) {
    const m = /^([a-zA-Z]+)(?:\[(\d{1,3})\])?$/.exec(part);
    if (!m) return null;
    segs.push({ key: m[1]!, index: m[2] === undefined ? null : Number(m[2]) });
  }
  return segs;
}

export const isDocPath = (p: string): p is DocPath => DOC_PATH_RE.test(p);
export const isItemPath = (p: string): boolean => ITEM_PATH_RE.test(p);

/** 경로의 값(문자열·객체·배열). 없으면 undefined. */
export function getAt(doc: ResumeDocument, path: string): unknown {
  const segs = parsePath(path);
  if (!segs) return undefined;
  let cur: unknown = doc;
  for (const s of segs) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[s.key];
    if (s.index !== null) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s.index];
    }
  }
  return cur;
}

/** 줄 경로의 문자열 값. 없거나 문자열이 아니면 null. */
export function lineValue(doc: ResumeDocument, path: string): string | null {
  const v = getAt(doc, path);
  return typeof v === "string" ? v : null;
}

/** 줄 경로에 값을 쓴다(배열 원소면 그 자리, 필드면 덮어쓰기). 경로가 없으면 false. */
export function setLine(doc: ResumeDocument, path: string, value: string): boolean {
  const segs = parsePath(path);
  if (!segs || !isDocPath(path)) return false;
  let cur: unknown = doc;
  for (const [i, s] of segs.entries()) {
    const last = i === segs.length - 1;
    const obj = cur as Record<string, unknown>;
    if (last) {
      if (s.index === null) {
        if (typeof obj[s.key] !== "string") return false;
        obj[s.key] = value;
        return true;
      }
      const arr = obj[s.key];
      if (!Array.isArray(arr) || s.index >= arr.length) return false;
      arr[s.index] = value;
      return true;
    }
    cur = obj[s.key];
    if (s.index !== null) cur = Array.isArray(cur) ? cur[s.index] : undefined;
    if (cur == null || typeof cur !== "object") return false;
  }
  return false;
}

/** 경로가 가리키는 배열과 인덱스("experience[0].bullets[2]" → { container: "experience[0].bullets", index: 2 }). */
export function arraySlot(path: string): { container: string; index: number } | null {
  const m = /^(.*)\[(\d{1,3})\]$/.exec(path);
  return m ? { container: m[1]!, index: Number(m[2]) } : null;
}

/** 배열 경로("experience[0].bullets")의 배열 자체. */
export function arrayAt(doc: ResumeDocument, container: string): unknown[] | null {
  const segs = parsePath(container);
  if (!segs) return null;
  let cur: unknown = doc;
  for (const s of segs) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[s.key];
    if (s.index !== null) cur = Array.isArray(cur) ? cur[s.index] : undefined;
  }
  return Array.isArray(cur) ? cur : null;
}

/** 서술 줄(인용·사실 검증 대상) 전체: [경로, 값]. 빈 값도 포함한다(호출부가 거른다). */
export function linePaths(doc: ResumeDocument): { path: DocPath; value: string }[] {
  const out: { path: string; value: string }[] = [];
  out.push({ path: "summary", value: doc.summary });
  out.push({ path: "basics.tagline", value: doc.basics.tagline });
  out.push({ path: "basics.totalExperience", value: doc.basics.totalExperience });
  doc.highlights.forEach((h, i) => {
    out.push({ path: `highlights[${i}].title`, value: h.title });
    h.details.forEach((d, j) => out.push({ path: `highlights[${i}].details[${j}]`, value: d }));
  });
  doc.experience.forEach((e, i) => {
    out.push({ path: `experience[${i}].scope`, value: e.scope });
    e.bullets.forEach((b, j) => out.push({ path: `experience[${i}].bullets[${j}]`, value: b }));
  });
  doc.projects.forEach((p, i) => {
    for (const k of ["summary", "problem", "action", "result"] as const) out.push({ path: `projects[${i}].${k}`, value: p[k] });
    p.bullets.forEach((b, j) => out.push({ path: `projects[${i}].bullets[${j}]`, value: b }));
  });
  doc.skills.forEach((s, i) => out.push({ path: `skills[${i}].detail`, value: s.detail }));
  doc.extras.forEach((x, i) => x.items.forEach((it, j) => out.push({ path: `extras[${i}].items[${j}]`, value: it })));
  doc.education.forEach((e, i) => out.push({ path: `education[${i}].note`, value: e.note }));
  return out as { path: DocPath; value: string }[];
}

/**
 * 줄 경로의 상위 항목 경로. 요약 영역(basics.tagline·totalExperience)은 summary 인용을 물려받는다.
 * extras[i].items[j]는 그 자체가 항목이다.
 */
export function itemPathOf(path: string): string {
  if (path === "summary" || path.startsWith("basics.")) return "summary";
  const m = /^(highlights|experience|projects|skills|education|certifications)\[(\d{1,3})\]/.exec(path);
  if (m) return `${m[1]}[${m[2]}]`;
  return path;
}

/** 줄의 근거 ref(줄 경로 인용 ∪ 상위 항목 인용). */
export function refsForLine(citations: readonly Citation[], path: string): string[] {
  const item = itemPathOf(path);
  const set = new Set<string>();
  for (const c of citations) if (c.path === path || c.path === item) for (const r of c.refs) set.add(r);
  return [...set];
}

/** 줄이 대응하는 요건 ID(줄 경로 인용 ∪ 상위 항목 인용). */
export function requirementsForLine(citations: readonly Citation[], path: string): string[] {
  const item = itemPathOf(path);
  const set = new Set<string>();
  for (const c of citations) if (c.path === path || c.path === item) for (const r of c.requirementIds) set.add(r);
  return [...set];
}

/** 항목 경로가 문서에 실제로 있는가(줄 경로면 문자열 값이 있어야 한다). */
export function resolvePath(doc: ResumeDocument, path: string): boolean {
  if (isDocPath(path)) return lineValue(doc, path) !== null;
  if (!isItemPath(path)) return false;
  if (path === "summary") return true;
  const v = getAt(doc, path);
  return v !== undefined && v !== null;
}

/**
 * 모델이 낸(느슨한) 인용을 거른다: 경로 문법·존재, ref가 pack에 있는지(없는 ref는 뺀다), 요건 ID 화이트리스트.
 * 같은 경로 인용은 합친다. invalidRefPaths: ref가 모두 pack 밖이라 버린 인용의 경로.
 */
export function parseCitations(
  raw: readonly { path: string; refs: readonly string[]; requirementIds: readonly string[] }[],
  doc: ResumeDocument,
  packRefs: ReadonlySet<string>,
  requirementIds: ReadonlySet<string>,
): { citations: Citation[]; invalidRefPaths: string[] } {
  const byPath = new Map<string, Citation>();
  const invalidRefPaths: string[] = [];
  for (const c of raw) {
    const path = c.path.trim();
    if (!resolvePath(doc, path)) continue;
    const refs = [...new Set(c.refs.map((r) => r.trim().replace(/^\[|\]$/g, "")).filter((r) => packRefs.has(r)))];
    if (refs.length === 0) {
      if (c.refs.length > 0) invalidRefPaths.push(path);
      continue;
    }
    const reqs = [...new Set(c.requirementIds.map((r) => r.trim()).filter((r) => requirementIds.has(r)))];
    const prev = byPath.get(path);
    if (prev) {
      prev.refs = [...new Set([...prev.refs, ...refs])].slice(0, 8);
      prev.requirementIds = [...new Set([...prev.requirementIds, ...reqs])].slice(0, 6);
    } else byPath.set(path, { path, refs: refs.slice(0, 8), requirementIds: reqs.slice(0, 6) });
  }
  return { citations: [...byPath.values()], invalidRefPaths };
}

/**
 * 심사 quote → 줄 경로들. 정규화(normalizeForQuote) 후 줄 값에 quote가 있거나(생략 부호 허용), 긴 quote가 줄 값을 포함하면 그 줄.
 * 경력·프로젝트 머리글(회사 | 직무 | 기간)처럼 줄 경로가 아닌 곳의 quote는 찾지 못한다(빈 배열).
 */
export function locateQuote(doc: ResumeDocument, quote: string | null | undefined): DocPath[] {
  if (!quote?.trim()) return [];
  const q = normalizeForQuote(quote.replace(/^[-•]\s*/, "").replace(/^(문제|개선|행동|결과|근거):\s*/, ""));
  const out: DocPath[] = [];
  for (const { path, value } of linePaths(doc)) {
    if (!value.trim()) continue;
    const v = normalizeForQuote(value);
    if (verifyQuote(value, quote) || (v.length >= 8 && q.includes(v))) out.push(path);
  }
  return out.slice(0, 8);
}

/** 수정 프롬프트용: 경로가 붙은 문서 텍스트. 항목 머리글은 [experience[0]] 처럼 항목 경로로 적는다. */
export function numberedDocText(doc: ResumeDocument): string {
  const lines: string[] = [];
  const add = (path: string, v: string) => {
    if (v.trim()) lines.push(`[${path}] ${v.replace(/\s+/g, " ").trim()}`);
  };
  add("basics.tagline", doc.basics.tagline);
  add("basics.totalExperience", doc.basics.totalExperience);
  add("summary", doc.summary);
  doc.highlights.forEach((h, i) => {
    add(`highlights[${i}].title`, h.title);
    h.details.forEach((d, j) => add(`highlights[${i}].details[${j}]`, d));
  });
  doc.experience.forEach((e, i) => {
    add(`experience[${i}]`, [e.company, e.department, e.title, `${e.startDate} ~ ${e.endDate}`].filter((x) => x.trim()).join(" | "));
    add(`experience[${i}].scope`, e.scope);
    e.bullets.forEach((b, j) => add(`experience[${i}].bullets[${j}]`, b));
  });
  doc.projects.forEach((p, i) => {
    add(`projects[${i}]`, [p.name, p.company, p.role, `${p.startDate} ~ ${p.endDate}`, p.techs.length ? `기술: ${p.techs.join(", ")}` : ""].filter((x) => x.trim() && x.trim() !== "~").join(" | "));
    for (const k of ["summary", "problem", "action", "result"] as const) add(`projects[${i}].${k}`, p[k]);
    p.bullets.forEach((b, j) => add(`projects[${i}].bullets[${j}]`, b));
  });
  doc.skills.forEach((s, i) => {
    add(`skills[${i}]`, [s.category, s.items.join(", ")].filter(Boolean).join(": "));
    add(`skills[${i}].detail`, s.detail);
  });
  doc.education.forEach((e, i) => {
    add(`education[${i}]`, [e.school, e.degree, e.major].filter(Boolean).join(" | "));
    add(`education[${i}].note`, e.note);
  });
  doc.certifications.forEach((c, i) => add(`certifications[${i}]`, [c.name, c.issuer, c.date].filter(Boolean).join(" | ")));
  doc.extras.forEach((x, i) => x.items.forEach((it, j) => add(`extras[${i}].items[${j}]`, `${x.title ? `${x.title}: ` : ""}${it}`)));
  return lines.join("\n");
}

/** 배열 원소 삭제·삽입 뒤 인용 경로를 옮긴다(container[index] 이후 원소 경로의 번호를 delta만큼). */
export function shiftCitations(citations: Citation[], container: string, index: number, delta: 1 | -1): Citation[] {
  const prefix = `${container}[`;
  const out: Citation[] = [];
  for (const c of citations) {
    if (!c.path.startsWith(prefix)) {
      out.push(c);
      continue;
    }
    const m = /^\[(\d{1,3})\](.*)$/.exec(c.path.slice(container.length));
    if (!m) {
      out.push(c);
      continue;
    }
    const i = Number(m[1]);
    if (delta === -1 && i === index) continue; // 지운 원소의 인용
    const next = i >= index + (delta === -1 ? 1 : 0) ? i + delta : i;
    out.push({ ...c, path: `${container}[${next}]${m[2]}` });
  }
  return out;
}

/**
 * 전략이 뺀 근거 ref(plan.exclude) 중 실제로 뺄 것. 같은 ref를 넣기로도 했으면(include·충족/부분 요건 근거·키워드 계획) 넣는 쪽이 이긴다.
 * 초안·수정·검증·리포트가 모두 이 집합을 쓴다(전략의 '제외'가 조언으로 끝나지 않게).
 */
export function excludedRefs(plan: {
  requirementMap?: readonly { status: string; refs: readonly string[] }[];
  include?: { experience: readonly { ref: string }[]; projects: readonly { ref: string }[]; extras: readonly { ref: string }[] };
  exclude?: readonly { ref: string }[];
  keywordPlan?: readonly { ref: string }[];
} | null | undefined): Set<string> {
  if (!plan?.exclude?.length) return new Set();
  const used = new Set<string>([
    ...(plan.requirementMap ?? []).filter((r) => r.status !== "gap").flatMap((r) => r.refs),
    ...(plan.include?.experience ?? []).map((e) => e.ref),
    ...(plan.include?.projects ?? []).map((e) => e.ref),
    ...(plan.include?.extras ?? []).map((e) => e.ref),
    ...(plan.keywordPlan ?? []).map((k) => k.ref),
  ]);
  return new Set(plan.exclude.map((e) => e.ref).filter((r) => !used.has(r)));
}
