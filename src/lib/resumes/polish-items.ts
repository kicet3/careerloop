/**
 * 이력서 AI로 다듬기 — 항목 제안 검증(순수, 결정적): LLM의 항목 고치기·추가 출력 → 저장할 제안(src/lib/domain/resume-polish-items.ts).
 *
 * LLM 출력은 믿지 않는다:
 * - 섹션·칸 이름은 허용 목록(POLISH_ITEM_FIELDS)만. 고치기는 지금 문서에 있는 항목만(칸 모드는 대상 칸의 항목으로 서버가 고정한다).
 *   추가는 섹션 상한(ResumeDocumentSchema max)을 넘지 않을 때만, 자리는 0~길이(그 밖이면 맨 뒤).
 * - before는 서버가 지금 문서 값으로 채운다. 칸 글자·줄 수 상한은 문서 스키마에서 읽어 자른다. 새 항목은 문서 스키마로 다시 검증한다.
 * - 근거(이력서·JD·그래프·도구 결과·사용자 말)에 없는 숫자는 칸 모드와 같은 규칙으로 [ADD: 수치 확인 — …]. 기간 칸은 감쌀 자리가 없어 그 변경을 버린다.
 * - 기술명·이름 같은 사실 칸은 '사용자 경험 근거'(facts — JD·JD 분석 도구 결과를 뺀 것)로만 확인한다. JD에 있다고 사용자가 해 본 것은 아니다.
 *   근거에 없는 기술명은 뺀다(낱말 단위로 맞춘다 — "Go"가 "google", "Java"가 "JavaScript"에 맞지 않게).
 * - 이름·회사·직무·부서(IDENTITY_FIELDS)는 고치기·추가 모두 근거에 없으면 [ADD: 이름 확인 — …]/[ADD: 사실 확인 — …]로 둔다.
 *   역할·팀 구성(FLAG_FIELDS)은 풀어 쓰는 칸이라 값은 두고 '근거 확인 필요'로 표시한다.
 * - 추가는 이름(프로젝트 이름 또는 회사, 경력은 회사)이 근거에 있을 때만 받는다 — 근거 없는 새 항목을 통째로 지어내지 않는다.
 *   추가하는 프로젝트의 문제·개선·결과(경력은 직무·담당 범위)가 비어 있으면 [ADD: …] 자리표시로 채운다.
 * - 고치기 제안에는 대상 항목의 정체 스냅샷(anchor)을 남긴다 — 순서가 바뀌어 같은 자리에 다른 항목이 오면 적용하지 않는다.
 * - 문체: 서술 칸(HONORIFIC_ITEM_FIELDS — 요약·문제·개선·결과·기여 줄·담당 범위)만 숫자 자리표시를 넣은 뒤 경어체로 맞춘다(normalizeHonorific).
 *   이름·회사·팀·역할·직무·기간·기술 칸은 건드리지 않는다. 바꾸지 못한 평어체 문장이 남으면 제안은 두고 reason에 '문체 확인 필요'를 붙인다.
 */
import {
  emptyPolishItem,
  isPolishItemField,
  isPolishItemSection,
  POLISH_ITEM_DATE_FIELDS,
  POLISH_ITEM_FIELDS,
  POLISH_ITEM_LIST_FIELDS,
  POLISH_ITEM_SECTION_LABEL,
  polishItemFieldLabel,
  polishItemFieldLimit,
  polishItemAnchor,
  polishItemFieldValue,
  polishItemLabel,
  polishItemPresent,
  polishItemSectionMax,
  type PolishItemChange,
  type PolishItemRecord,
  type PolishItemSection,
  type PolishItemSuggestion,
  type PolishItemValue,
  samePolishItemValue,
} from "@/lib/domain/resume-polish-items";
import { type ResumeDocument, ResumeDocumentSchema } from "@/lib/domain/resumes";
import { flagUnverified } from "@/lib/resume-agent/verify";
import { compactKey } from "@/lib/skills/dictionary";
import { stripPlaceholders, unverifiedNumbers } from "@/lib/text/numbers";
import { normalizeHonorific } from "./honorific";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// 문체(경어체) — 칸·전체·항목 제안 공용
// ---------------------------------------------------------------------------

/** 경어체로 맞추는 항목 칸(서술 칸만). 이름·회사·팀·역할·직무·부서·기간·지역·기술은 사실 칸이라 건드리지 않는다. */
export const HONORIFIC_ITEM_FIELDS: Record<PolishItemSection, ReadonlySet<string>> = {
  projects: new Set(["summary", "problem", "action", "result", "bullets"]),
  experience: new Set(["scope", "bullets"]),
};

/** 바꾸지 못한 평어체 문장이 남았을 때 reason에 붙이는 표시. */
export const HONORIFIC_CAUTION = "문체 확인 필요";

/** 다듬기 답변·제안이 인용에 흔히 쓰는 ASCII 작은따옴표 쌍('…했다.'). honorific.ts는 굽은 따옴표만 보호하므로 여기서 감싼다. */
const ASCII_QUOTE_RE = /'([^'\n]*)'/g;
/** 인용 구간을 잠시 바꿔 둘 보호 따옴표 쌍(honorific.ts PROTECTED_RE가 아는 것). 글에 없는 쌍만 쓴다. */
const QUOTE_SHIELDS: readonly [string, string][] = [
  ["「", "」"],
  ["『", "』"],
  ["“", "”"],
];

/**
 * normalizeHonorific + ASCII 작은따옴표 안 보호: 답변이 사용자 글을 '…줄였다.'처럼 인용하면 그 인용은 바꾸지 않는다
 * (사용자가 쓴 글을 고쳐 인용하지 않는다). 보호 쌍을 고를 수 없으면(글에 이미 다 있으면) 그냥 normalizeHonorific.
 */
export function politeText(text: string): { text: string; leftovers: string[] } {
  const shield = text.includes("'") ? QUOTE_SHIELDS.find(([a, b]) => !text.includes(a) && !text.includes(b)) : undefined;
  if (!shield) {
    const r = normalizeHonorific(text);
    return { text: r.text, leftovers: r.leftovers };
  }
  const [a, b] = shield;
  const r = normalizeHonorific(text.replace(ASCII_QUOTE_RE, `${a}$1${b}`));
  const back = (t: string) => t.split(a).join("'").split(b).join("'");
  return { text: back(r.text), leftovers: r.leftovers.map(back) };
}

/** 제안 글 → 경어체(숫자 자리표시를 넣은 뒤 부른다 — [ADD: …]·따옴표 안은 그대로). leftovers: 바꾸지 못한 평어체 문장. */
export const politeSuggestion = politeText;

/** 문체만 맞춘 비교 키: 원문을 경어체로만 바꾼 제안은 '같은 글'로 본다(사용자가 쓴 글을 문체만 바꿔 덮지 않는다). */
export const politeKey = (text: string): string => norm(politeText(text).text);

/** 남은 평어체 문장이 있으면 reason 끝에 '문체 확인 필요: …'를 붙인다(제안은 버리지 않는다). */
export function withHonorificCaution(reason: string, leftovers: readonly string[]): string {
  if (leftovers.length === 0) return reason;
  const first = leftovers[0]!;
  const note = `${HONORIFIC_CAUTION}: '${first.length > 30 ? `…${first.slice(-29)}` : first}'${leftovers.length > 1 ? " 외" : ""}`;
  return reason ? `${reason} · ${note}` : note;
}

/** 추가할 때 비어 있으면 채우는 자리표시(핵심 칸 — 모르는 사실을 지어내지 않고 사용자에게 받는다). */
const ADD_PLACEHOLDERS: Record<PolishItemSection, Record<string, string>> = {
  projects: {
    name: "[ADD: 프로젝트 이름]",
    problem: "[ADD: 문제 — 어떤 자료로 어떤 상황·원인을 확인했는지]",
    action: "[ADD: 개선 — 본인이 바꾼 방법·실행한 일]",
    result: "[ADD: 결과 — 기간·대상과 지표 전후 변화]",
  },
  experience: {
    company: "[ADD: 회사 이름]",
    title: "[ADD: 직무·직급]",
    scope: "[ADD: 담당 범위 — 주요 책임 한 문장]",
  },
};
/** 이름·사실 칸: 근거(facts)에 그대로 있어야 한다 — 없으면 [ADD: … 확인 — 값]. */
const IDENTITY_FIELDS: Record<PolishItemSection, readonly string[]> = { projects: ["name", "company"], experience: ["company", "department", "title"] };
const NAME_FIELDS: ReadonlySet<string> = new Set(["name", "company"]);
/** 풀어 쓰는 사실 칸: 근거에 없으면 값은 두고 표시만 한다. */
const FLAG_FIELDS: Record<PolishItemSection, readonly string[]> = { projects: ["team", "role"], experience: [] };
/** 추가를 받을 근거 이름 칸(하나라도 근거에 있어야 한다). */
const ANCHOR_NAME_FIELDS: Record<PolishItemSection, readonly string[]> = { projects: ["name", "company"], experience: ["company"] };

/** 사실 근거에 그 이름이 있는가(공백·점·밑줄·하이픈 차이는 무시). 두 글자 미만은 근거로 보지 않는다. */
function inFacts(facts: string, value: string): boolean {
  const key = compactKey(value);
  return key.length >= 2 && compactKey(facts).includes(key);
}

/**
 * 기술명이 사실 근거에 낱말로 있는가. 부분 문자열로 맞추지 않는다("Go" ⊄ "google", "Java" ⊄ "JavaScript", "C" ⊄ "C++").
 * 표기 차이(Node.js / NodeJS / node js)는 낱말을 compactKey로 맞춘다.
 */
function techInFacts(facts: string, term: string): boolean {
  const t = term.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  const text = facts.normalize("NFKC").toLowerCase();
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s._-]*");
  if (new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9+#])`, "u").test(text)) return true;
  const key = compactKey(t);
  return key.length > 0 && text.split(/[\s,/()|·•:;'"`<>\[\]{}]+/).some((w) => compactKey(w.replace(/^[.\-_]+|[.\-_]+$/g, "")) === key);
}

export interface RawItemSuggestion {
  kind?: unknown;
  section?: unknown;
  index?: unknown;
  changes?: unknown;
  reason?: unknown;
}

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…` : t);

function listValues(field: string, value: string): string[] {
  const parts = field === "techs" ? value.split(/[\n,]/) : value.split("\n");
  return parts.map((x) => x.replace(/^\s*(?:[-•·*]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

/**
 * 칸 하나의 새 값을 검증한다. 버릴 값이면 null(flagged에 이유가 될 값을 남긴다).
 * evidence: 숫자 근거(before 값 포함). facts: 기술·이름 근거(JD를 뺀 것, before 값 포함).
 * keepLines: 목록 칸의 지금 줄(사용자가 쓴 줄) — 그대로 다시 온 줄은 문체를 바꾸지 않는다.
 */
function verifyValue(
  section: PolishItemSection,
  field: string,
  raw: string,
  evidence: string,
  facts: string,
  keepLines: readonly string[] = [],
): { value: PolishItemValue; flagged: string[]; style: string[] } | null {
  const { maxChars, maxItems } = polishItemFieldLimit(section, field);
  const polite = HONORIFIC_ITEM_FIELDS[section].has(field);
  /** 바꾸지 못한 평어체 문장(서술 칸만). */
  const style: string[] = [];
  const fixStyle = (t: string): string => {
    if (!polite) return t;
    const r = politeSuggestion(t);
    style.push(...r.leftovers);
    return r.text;
  };
  const bad = (t: string) => unverifiedNumbers(stripPlaceholders(t), evidence);
  const flagged: string[] = [];
  const text = raw.replace(/\r/g, "").trim();
  if (POLISH_ITEM_LIST_FIELDS.has(field)) {
    const out: string[] = [];
    const kept = new Set(keepLines.map(norm));
    for (let v of listValues(field, text)) {
      if (maxItems !== null && out.length >= maxItems) break;
      if (field === "techs") {
        // 기술명은 근거에 있어야 한다(지어낸 기술 스택을 넣지 않는다).
        if (bad(v).length > 0 || !techInFacts(facts, v)) {
          flagged.push(v.slice(0, 60));
          continue;
        }
        out.push(clip(v, maxChars));
        continue;
      }
      const nums = bad(v);
      if (nums.length > 0) {
        flagged.push(...nums);
        v = flagUnverified(v, bad, maxChars);
      }
      // 지금 있는 줄을 그대로 다시 낸 것이면 사용자가 쓴 글이라 문체를 바꾸지 않는다.
      out.push(clip(kept.has(norm(v)) ? v : fixStyle(v), maxChars));
    }
    return { value: [...new Set(out)], flagged: [...new Set(flagged)], style };
  }
  let value = text.replace(/\n{3,}/g, "\n\n");
  if (!value) return { value: "", flagged, style };
  if (POLISH_ITEM_DATE_FIELDS.has(field)) {
    // 기간은 근거에 있는 값만(20자 칸이라 자리표시로 감쌀 수 없다). 표기(2023-01·2023.01)는 달라도 되게 숫자 묶음으로 본다.
    const known = new Set(evidence.match(/\d+/g) ?? []);
    const unknown = (value.match(/\d+/g) ?? []).filter((d) => !known.has(d) && !known.has(String(Number(d))) && !known.has(d.padStart(2, "0")));
    if (/\[ADD:/.test(value)) return { value: "", flagged, style };
    if (unknown.length > 0) return { value: "", flagged: [value.slice(0, 20)], style };
    return { value: clip(value, maxChars), flagged, style };
  }
  const nums = bad(value);
  if (IDENTITY_FIELDS[section].includes(field) && !/\[ADD:/.test(value) && !inFacts(facts, value)) {
    // 이름·회사·직무가 사용자 경험 근거에 없다 — 지어냈거나 JD에서 가져온 값일 수 있어 확인을 받는다.
    flagged.push(value.slice(0, 60));
    const prefix = NAME_FIELDS.has(field) ? "[ADD: 이름 확인 — " : "[ADD: 사실 확인 — ";
    return { value: `${prefix}${value.replace(/[[\]]/g, "").slice(0, Math.max(0, maxChars - prefix.length - 1)).trimEnd()}]`, flagged, style };
  }
  if (FLAG_FIELDS[section].includes(field) && !/\[ADD:/.test(value) && !inFacts(facts, value)) flagged.push(value.slice(0, 60));
  if (nums.length > 0) {
    flagged.push(...nums);
    value = flagUnverified(value, bad, maxChars);
  }
  return { value: clip(fixStyle(value), maxChars), flagged, style };
}

function rawChanges(raw: unknown): { field: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 30)
    .filter((c): c is { field: string; value: string } => !!c && typeof c === "object" && typeof c.field === "string" && typeof c.value === "string");
}

/**
 * LLM 항목 제안 하나 → 저장할 제안(버리면 null).
 * - source: 숫자 근거(이력서·JD·그래프·도구 결과·사용자 말). facts: 기술·이름 근거 — source에서 JD·JD 분석 결과를 뺀 것(없으면 source).
 * - fixed: 칸 모드처럼 대상 항목을 서버가 정할 때(LLM의 kind·section·index를 무시하고 이 항목 고치기로 본다).
 * - skipFields: 받지 않을 칸(칸 모드에서 대상이 목록 줄이면 그 목록 칸 — 줄 경로가 사라지거나 다른 줄을 가리키지 않게).
 * - allowAdd: 추가 제안을 받을지(칸 모드는 받지 않는다). pendingAdds: 같은 답변에서 앞서 받은 추가 수(섹션 상한 계산).
 */
export function verifyItemSuggestion(
  raw: RawItemSuggestion,
  doc: ResumeDocument,
  source: string,
  opts: {
    facts?: string;
    fixed?: { section: PolishItemSection; index: number };
    skipFields?: readonly string[];
    allowAdd: boolean;
    pendingAdds?: Partial<Record<PolishItemSection, number>>;
  },
): PolishItemSuggestion | null {
  const facts = opts.facts ?? source;
  const section = opts.fixed?.section ?? raw.section;
  if (!isPolishItemSection(section)) return null;
  const kind = opts.fixed ? "edit" : raw.kind;
  const items = doc[section] as unknown[];
  const reason = norm(typeof raw.reason === "string" ? raw.reason : "").slice(0, 200);
  const changesIn = rawChanges(raw.changes);

  if (kind === "edit") {
    const index = opts.fixed?.index ?? raw.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= items.length) return null;
    const cur = items[index];
    const seen = new Set<string>();
    const changes: PolishItemChange[] = [];
    // 근거가 없어 버린 칸 값(기간·기술)도 카드에 '근거 확인 필요'로 보인다.
    const droppedFlags: string[] = [];
    const style: string[] = [];
    for (const c of changesIn) {
      if (!isPolishItemField(section, c.field) || seen.has(c.field) || opts.skipFields?.includes(c.field)) continue;
      seen.add(c.field);
      const before = polishItemFieldValue(cur, c.field);
      if (before === null) continue;
      const beforeText = polishItemValueSource(before);
      const v = verifyValue(section, c.field, c.value, `${beforeText}\n${source}`, `${beforeText}\n${facts}`, Array.isArray(before) ? before : []);
      if (!v) continue;
      // 빈 값으로 지우는 제안은 받지 않는다(지우기는 사용자가 직접). 지금 값과 같으면 뺀다.
      if (Array.isArray(v.value) ? v.value.length === 0 : !v.value) {
        droppedFlags.push(...v.flagged);
        continue;
      }
      if (Array.isArray(v.value) ? samePolishItemValue(v.value, before) : norm(v.value) === norm(before as string)) continue;
      // 문체만 다른 값(지금 값을 경어체로만 바꾼 것)도 같은 값으로 본다 — 사용자가 쓴 칸을 문체만 바꿔 덮지 않는다.
      if (HONORIFIC_ITEM_FIELDS[section].has(c.field)) {
        const politeBefore = Array.isArray(before) ? before.map((b) => politeText(b).text) : politeKey(before);
        if (Array.isArray(v.value) ? samePolishItemValue(v.value, politeBefore as string[]) : norm(v.value) === politeBefore) continue;
      }
      style.push(...v.style);
      changes.push({ field: c.field, label: polishItemFieldLabel(section, c.field), before, after: v.value, flagged: v.flagged });
    }
    if (changes.length === 0) return null;
    return {
      kind: "item-edit",
      section,
      index,
      label: polishItemLabel(doc, section, index),
      changes,
      reason: withHonorificCaution(reason, style),
      flagged: [...new Set([...changes.flatMap((c) => c.flagged), ...droppedFlags])],
      anchor: polishItemAnchor(section, cur, changes.map((c) => c.field)),
    };
  }

  if (kind !== "add" || !opts.allowAdd) return null;
  const pending = opts.pendingAdds?.[section] ?? 0;
  if (items.length + pending >= polishItemSectionMax(section)) return null;
  const rawIndex = raw.index;
  const index = typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex <= items.length ? rawIndex : items.length;
  const item = emptyPolishItem(section);
  const flaggedByField = new Map<string, string[]>();
  const seen = new Set<string>();
  const addStyle: string[] = [];
  for (const c of changesIn) {
    if (!isPolishItemField(section, c.field) || seen.has(c.field)) continue;
    seen.add(c.field);
    const v = verifyValue(section, c.field, c.value, source, facts);
    if (!v) continue;
    item[c.field] = v.value;
    addStyle.push(...v.style);
    if (v.flagged.length) flaggedByField.set(c.field, v.flagged);
  }
  // 근거(facts)에 있는 이름(프로젝트 이름·회사, 경력은 회사)이 하나도 없으면 추가하지 않는다 —
  // 이름까지 자리표시인 새 항목은 요약·문제·개선을 통째로 지어낸 것일 수 있다.
  const grounded = ANCHOR_NAME_FIELDS[section].some((f) => {
    const v = item[f];
    return typeof v === "string" && !!v.trim() && !/\[ADD:/.test(v);
  });
  if (!grounded) return null;
  for (const [f, ph] of Object.entries(ADD_PLACEHOLDERS[section])) if (!String(item[f] ?? "").trim()) item[f] = ph;
  if (polishItemPresent(section, items, item)) return null;
  const parsed = (ResumeDocumentSchema.shape[section].element as unknown as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }).safeParse(item);
  if (!parsed.success) return null;
  const finalItem = parsed.data as PolishItemRecord;
  const changes: PolishItemChange[] = POLISH_ITEM_FIELDS[section]
    .filter((f) => (Array.isArray(finalItem[f]) ? finalItem[f].length > 0 : !!finalItem[f]))
    .map((f) => ({
      field: f,
      label: polishItemFieldLabel(section, f),
      before: POLISH_ITEM_LIST_FIELDS.has(f) ? [] : "",
      after: finalItem[f]!,
      flagged: flaggedByField.get(f) ?? [],
    }));
  const name = String(finalItem[section === "projects" ? "name" : "company"] ?? "");
  return {
    kind: "item-add",
    section,
    index,
    label: `새 ${POLISH_ITEM_SECTION_LABEL[section]}${name && !/\[ADD:/.test(name) ? ` · ${name.slice(0, 30)}` : ""}`,
    changes,
    item: finalItem,
    reason: withHonorificCaution(reason, addStyle),
    flagged: [...new Set([...flaggedByField.values()].flat())],
  };
}

const polishItemValueSource = (v: PolishItemValue): string => (Array.isArray(v) ? v.join("\n") : v);

/** 전체 이력서 모드: 항목 제안 여러 개(최대 max). 같은 항목 고치기는 첫 제안만. 버린 수도 돌려준다. */
export function verifyItemSuggestions(
  raw: readonly RawItemSuggestion[],
  doc: ResumeDocument,
  source: string,
  max: number,
  facts: string = source,
): { suggestions: PolishItemSuggestion[]; dropped: number } {
  const out: PolishItemSuggestion[] = [];
  const pendingAdds: Partial<Record<PolishItemSection, number>> = {};
  const editedItems = new Set<string>();
  let dropped = 0;
  for (const r of raw) {
    if (out.length >= max) {
      dropped++;
      continue;
    }
    const s = verifyItemSuggestion(r, doc, source, { facts, allowAdd: true, pendingAdds });
    const key = s?.kind === "item-edit" ? `${s.section}[${s.index}]` : null;
    const dupAdd = s?.kind === "item-add" && out.some((o) => o.kind === "item-add" && o.section === s.section && polishItemPresent(s.section, [o.item], s.item!));
    if (!s || (key && editedItems.has(key)) || dupAdd) {
      dropped++;
      continue;
    }
    if (key) editedItems.add(key);
    if (s.kind === "item-add") pendingAdds[s.section] = (pendingAdds[s.section] ?? 0) + 1;
    out.push(s);
  }
  return { suggestions: out, dropped };
}

/** 칸 경로가 항목 고치기 제안이 바꾸는 칸 안에 있는가(같은 칸을 고치는 칸 제안을 뺄 때). */
export function pathCoveredByItem(path: string, items: readonly PolishItemSuggestion[]): boolean {
  const m = /^(projects|experience)\[(\d{1,2})\]\.([a-zA-Z]+)/.exec(path);
  if (!m) return false;
  return items.some((s) => s.kind === "item-edit" && s.section === m[1] && s.index === Number(m[2]) && s.changes.some((c) => c.field === m[3]));
}

// ---------------------------------------------------------------------------
// 프롬프트용 항목 줄
// ---------------------------------------------------------------------------

/** 항목 칸 상한 안내(프롬프트용, 섹션마다 한 번). */
export function itemLimitsLine(section: PolishItemSection): string {
  return POLISH_ITEM_FIELDS[section]
    .map((f) => {
      const l = polishItemFieldLimit(section, f);
      return l.maxItems !== null ? `${f} ${l.maxItems}줄×${l.maxChars}자` : `${f} ${l.maxChars}자`;
    })
    .join(", ");
}

/** 한 항목의 칸 값 한 줄("name=…; role=…; bullets=a / b"). 빈 칸은 뺀다. */
export function polishItemLine(section: PolishItemSection, item: unknown): string {
  return POLISH_ITEM_FIELDS[section]
    .map((f) => {
      const v = polishItemFieldValue(item, f);
      const text = Array.isArray(v) ? v.join(" / ") : (v ?? "");
      return text.trim() ? `${f}=${text.replace(/\r/g, "").replace(/\n/g, " ")}` : "";
    })
    .filter(Boolean)
    .join("; ");
}
