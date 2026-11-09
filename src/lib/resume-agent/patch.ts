/**
 * 수정 패치 적용(순수). 모델은 문서를 다시 쓰지 않고 경로 단위 op만 낸다 — 적용한 op가 그대로 리포트의 "바뀐 점"이 된다.
 *
 * - op의 경로는 모두 "패치 전 문서" 기준이다. 적용 순서: 단일 칸 replace → 배열 원소 replace → 같은 배열 안 remove/insert를
 *   인덱스 내림차순(같은 인덱스면 remove 먼저) → addProject·setSkills → reorder(마지막).
 * - 잘못된 op(없는 경로·pack 밖 ref·스키마 상한 초과·잘못된 순열)는 그 op만 버리고 rejected에 남긴다.
 * - replace·insert는 줄 경로 인용(op.refs)을 붙인다 → 수정된 줄은 더 좁은 근거를 가진다.
 */
import { ResumeDocumentSchema, type ResumeDocument } from "@/lib/domain/resumes";
import { arrayAt, arraySlot, isDocPath, lineValue, parseCitations, setLine, shiftCitations } from "./citations";
import type { AgentDraft, ChangeRecord, Citation, LlmPatchOp, ReviewIssue } from "./schemas";

/** 줄 경로별 글자 상한(ResumeDocumentSchema와 같다). */
export function maxCharsFor(path: string): number {
  if (path === "summary") return 1500;
  if (path === "basics.tagline") return 200;
  if (path === "basics.totalExperience") return 40;
  if (/^highlights\[\d+\]\.title$/.test(path)) return 200;
  if (/^highlights\[\d+\]\.details\[\d+\]$/.test(path)) return 300;
  if (/^experience\[\d+\]\.scope$/.test(path)) return 600;
  if (/^projects\[\d+\]\.summary$/.test(path)) return 600;
  if (/^skills\[\d+\]\.detail$/.test(path) || /^extras\[\d+\]\.items\[\d+\]$/.test(path) || /^education\[\d+\]\.note$/.test(path)) return 300;
  return 500;
}

const MAX_ARRAY: Record<string, number> = { bullets: 15, items: 15, details: 5 };
const REORDER_SECTIONS = ["experience", "projects", "highlights", "skills"] as const;
type ReorderSection = (typeof REORDER_SECTIONS)[number];

export interface ApplyPatchResult {
  draft: AgentDraft;
  changes: ChangeRecord[];
  rejected: { op: string; path: string; reason: string }[];
}

export function applyPatch(
  input: AgentDraft,
  ops: readonly LlmPatchOp[],
  ctx: {
    packRefs: ReadonlySet<string>;
    requirementIds: ReadonlySet<string>;
    round: number;
    issues: readonly ReviewIssue[];
    /** 전략이 뺀 근거(citations.ts excludedRefs). 이것만 인용한 replace·insert·addProject는 버린다. */
    excludedRefs?: ReadonlySet<string>;
  },
): ApplyPatchResult {
  const draft: AgentDraft = structuredClone(input);
  const doc = draft.document;
  let citations: Citation[] = draft.citations;
  const changes: ChangeRecord[] = [];
  const rejected: ApplyPatchResult["rejected"] = [];
  const reviewersOf = (ids: readonly string[]) => [...new Set(ids.map((id) => ctx.issues.find((i) => i.id === id)?.reviewer).filter((r): r is NonNullable<typeof r> => !!r))];
  const record = (op: ChangeRecord["op"], path: string, before: string | null, after: string | null, issueIds: readonly string[]) =>
    changes.push({ round: ctx.round, op, path, before, after, issueIds: issueIds.slice(0, 10), reviewers: reviewersOf(issueIds) });
  const reject = (op: LlmPatchOp, reason: string) => rejected.push({ op: op.op, path: op.path || op.section || "", reason });
  const excluded = ctx.excludedRefs ?? new Set<string>();
  const cleanRefs = (refs: readonly string[]) => [...new Set(refs.map((r) => r.trim()).filter((r) => ctx.packRefs.has(r) && !excluded.has(r)))].slice(0, 8);
  const onlyExcluded = (refs: readonly string[]) => refs.some((r) => excluded.has(r.trim()));
  const lineCitation = (path: string, refs: string[], issueIds: readonly string[]) => {
    const reqs = [...new Set(issueIds.map((id) => ctx.issues.find((i) => i.id === id)?.requirementId).filter((r): r is string => !!r && ctx.requirementIds.has(r)))];
    citations = [...citations.filter((c) => c.path !== path), { path, refs, requirementIds: reqs.slice(0, 6) }];
  };

  // 검증 1차: 문법·존재·ref·글자 수.
  type Prepared = { op: LlmPatchOp; refs: string[] };
  const valid: Prepared[] = [];
  for (const op of ops) {
    const value = op.value.trim();
    if (op.op === "replace" || op.op === "insert" || op.op === "remove") {
      // 프로젝트 근거 칸(evidence)·핵심 성과 예전 칸(context)은 이력서에 쓰지 않는다 — 그 칸을 고치는 op는 버린다(상세 성과는 details[n]).
      if (!isDocPath(op.path) || /^projects\[\d+\]\.evidence$/.test(op.path) || /^highlights\[\d+\]\.context$/.test(op.path)) {
        reject(op, "path_invalid");
        continue;
      }
      if (op.op !== "insert" && lineValue(doc, op.path) === null) {
        reject(op, "path_missing");
        continue;
      }
      if (op.op === "insert") {
        const slot = arraySlot(op.path);
        const arr = slot ? arrayAt(doc, slot.container) : null;
        const kind = slot?.container.split(".").at(-1) ?? "";
        if (!slot || !arr || slot.index > arr.length || !(kind in MAX_ARRAY) || arr.length >= MAX_ARRAY[kind]!) {
          reject(op, "insert_invalid");
          continue;
        }
      }
      if (op.op !== "remove") {
        if (!value) {
          reject(op, "empty_value");
          continue;
        }
        if (value.length > maxCharsFor(op.path)) {
          reject(op, "too_long");
          continue;
        }
        const refs = cleanRefs(op.refs);
        if (refs.length === 0) {
          reject(op, onlyExcluded(op.refs) ? "refs_excluded" : "refs_invalid");
          continue;
        }
        valid.push({ op: { ...op, value }, refs });
      } else valid.push({ op, refs: [] });
      continue;
    }
    if (op.op === "reorder") {
      const sec = op.section as ReorderSection;
      const n = (REORDER_SECTIONS as readonly string[]).includes(sec) ? doc[sec].length : -1;
      const perm = [...op.order].sort((a, b) => a - b);
      if (n < 0 || op.order.length !== n || perm.some((v, i) => v !== i)) {
        reject(op, "order_invalid");
        continue;
      }
      valid.push({ op, refs: [] });
      continue;
    }
    if (op.op === "addProject") {
      const refs = cleanRefs(op.refs);
      if (refs.length === 0 && onlyExcluded(op.refs)) {
        reject(op, "refs_excluded");
        continue;
      }
      if (!op.project || refs.length === 0 || doc.projects.length >= 20 || !ResumeDocumentSchema.shape.projects.element.safeParse(op.project).success) {
        reject(op, "project_invalid");
        continue;
      }
      valid.push({ op, refs });
      continue;
    }
    if (op.op === "setSkills") {
      if (!op.skills || !ResumeDocumentSchema.shape.skills.safeParse(op.skills).success) {
        reject(op, "skills_invalid");
        continue;
      }
      valid.push({ op, refs: [] });
    }
  }

  // 같은 경로를 여러 op가 건드리면 첫 op만.
  const touched = new Set<string>();
  const uniq = valid.filter(({ op }, i) => {
    const key = op.op === "reorder" ? `reorder:${op.section}` : op.op === "insert" ? `insert:${op.path}:${op.value}` : op.op === "addProject" ? `addProject:${i}` : op.op === "setSkills" ? "setSkills" : op.path;
    if (touched.has(key)) {
      reject(op, "duplicate");
      return false;
    }
    touched.add(key);
    return true;
  });

  // 1) replace(단일 칸·배열 원소 모두 — 인덱스를 바꾸지 않는다).
  for (const { op, refs } of uniq.filter((v) => v.op.op === "replace")) {
    const before = lineValue(doc, op.path)!;
    if (before === op.value) continue;
    setLine(doc, op.path, op.value);
    lineCitation(op.path, refs, op.issueIds);
    record("replace", op.path, before, op.value, op.issueIds);
  }
  // 2) remove/insert: 배열별 인덱스 내림차순(같은 인덱스면 remove 먼저).
  const arrayOps = uniq.filter((v) => v.op.op === "remove" || v.op.op === "insert");
  const scalarRemoves = arrayOps.filter((v) => v.op.op === "remove" && !arraySlot(v.op.path));
  for (const { op } of scalarRemoves) {
    const before = lineValue(doc, op.path)!;
    setLine(doc, op.path, "");
    citations = citations.filter((c) => c.path !== op.path);
    record("remove", op.path, before, null, op.issueIds);
  }
  const slotted = arrayOps
    .filter((v) => arraySlot(v.op.path))
    .map((v) => ({ ...v, slot: arraySlot(v.op.path)! }))
    .sort((a, b) => (a.slot.container === b.slot.container ? b.slot.index - a.slot.index || (a.op.op === "remove" ? -1 : 1) : a.slot.container.localeCompare(b.slot.container)));
  for (const { op, refs, slot } of slotted) {
    const arr = arrayAt(doc, slot.container) as string[] | null;
    if (!arr) continue;
    if (op.op === "remove") {
      if (slot.index >= arr.length) continue;
      const [before] = arr.splice(slot.index, 1);
      citations = shiftCitations(citations, slot.container, slot.index, -1);
      record("remove", op.path, before ?? null, null, op.issueIds);
    } else {
      arr.splice(Math.min(slot.index, arr.length), 0, op.value);
      citations = shiftCitations(citations, slot.container, slot.index, 1);
      lineCitation(op.path, refs, op.issueIds);
      record("insert", op.path, null, op.value, op.issueIds);
    }
  }
  // 3) addProject · setSkills.
  for (const { op, refs } of uniq.filter((v) => v.op.op === "addProject")) {
    if (doc.projects.length >= 20 || !op.project) continue;
    doc.projects.push(op.project);
    const path = `projects[${doc.projects.length - 1}]`;
    const reqs = [...new Set(op.citations.flatMap((c) => c.requirementIds).filter((r) => ctx.requirementIds.has(r)))].slice(0, 6);
    citations.push({ path, refs, requirementIds: reqs });
    record("addProject", path, null, op.project.name, op.issueIds);
  }
  for (const { op } of uniq.filter((v) => v.op.op === "setSkills")) {
    const before = doc.skills.map((s) => [s.category, s.items.join(", ")].join(": ")).join(" / ");
    doc.skills = op.skills!;
    citations = citations.filter((c) => !/^skills\[/.test(c.path));
    const parsed = parseCitations(op.citations.filter((c) => /^skills\[\d+\]/.test(c.path)), doc, ctx.packRefs, ctx.requirementIds);
    citations.push(...parsed.citations);
    record("setSkills", "skills", before, doc.skills.map((s) => [s.category, s.items.join(", ")].join(": ")).join(" / "), op.issueIds);
  }
  // 4) reorder(마지막). 앞선 op로 길이가 바뀐 섹션의 reorder는 버린다(패치 전 기준 순열이 맞지 않는다).
  for (const { op } of uniq.filter((v) => v.op.op === "reorder")) {
    const sec = op.section as ReorderSection;
    const list = doc[sec] as unknown[];
    if (list.length !== op.order.length) {
      reject(op, "order_stale");
      continue;
    }
    if (op.order.every((v, i) => v === i)) continue;
    const before = op.order.map((_, i) => String(i)).join(",");
    (doc as unknown as Record<string, unknown[]>)[sec] = op.order.map((i) => list[i]);
    const pos = new Map(op.order.map((oldIdx, newIdx) => [oldIdx, newIdx]));
    citations = citations.map((c) => {
      const m = new RegExp(`^${sec}\\[(\\d+)\\](.*)$`).exec(c.path);
      return m ? { ...c, path: `${sec}[${pos.get(Number(m[1])) ?? Number(m[1])}]${m[2]}` } : c;
    });
    record("reorder", sec, before, op.order.join(","), op.issueIds);
  }

  const parsed = ResumeDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    // 상한 검증을 빠져나간 경우(드묾): 패치 전체를 버린다.
    return { draft: input, changes: [], rejected: [...rejected, ...uniq.map(({ op }) => ({ op: op.op, path: op.path || op.section, reason: "schema" }))] };
  }
  draft.document = parsed.data as ResumeDocument;
  draft.citations = citations.slice(0, 200);
  return { draft, changes: changes.slice(0, 60), rejected: rejected.slice(0, 40) };
}
