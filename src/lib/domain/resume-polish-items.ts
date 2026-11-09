/**
 * 이력서 AI로 다듬기 — 항목 단위 제안(클라이언트·서버 공용, 순수): 프로젝트·경력 항목 하나의 여러 칸을 한 번에 고치기(item-edit)와
 * 새 항목 추가(item-add).
 *
 * - 칸 제안({path, after})은 한 칸만 바꾼다. 항목 제안은 한 항목의 이름·역할·기간·문제·개선·결과·기여·기술 등 여러 칸을 한 카드로 내고,
 *   적용은 한 번에(원자적으로) 한다 — 고칠 칸 중 하나라도 제안 뒤 바뀌었으면 409이고 아무것도 바꾸지 않는다.
 * - 대상 항목·자리(index)·before는 서버가 지금 문서로 정한다(LLM 값을 믿지 않는다). 칸 글자·줄 수·항목 수 상한은 ResumeDocumentSchema에서 읽는다.
 * - 숫자 검증·근거 없는 기술·이름 처리는 서버(src/lib/resumes/polish-items.ts)가 한다. 이 파일은 계약과 문서 읽기·쓰기만 둔다.
 */
import { z } from "zod";
import { EMPTY_RESUME_ITEM, ResumeDocumentSchema, type ResumeDocument } from "./resumes";

// ---------------------------------------------------------------------------
// 항목 칸
// ---------------------------------------------------------------------------

export const POLISH_ITEM_SECTIONS = ["projects", "experience"] as const;
export type PolishItemSection = (typeof POLISH_ITEM_SECTIONS)[number];
export const isPolishItemSection = (s: unknown): s is PolishItemSection => (POLISH_ITEM_SECTIONS as readonly unknown[]).includes(s);

/** 항목 제안이 다룰 수 있는 칸(문서 스키마 순서). 목록 칸(bullets·techs)은 줄마다 하나. */
export const POLISH_ITEM_FIELDS = {
  projects: ["name", "company", "team", "role", "startDate", "endDate", "summary", "problem", "action", "result", "bullets", "techs"],
  experience: ["company", "department", "title", "startDate", "endDate", "location", "scope", "bullets"],
} as const satisfies Record<PolishItemSection, readonly string[]>;
export type PolishItemField = (typeof POLISH_ITEM_FIELDS)[PolishItemSection][number];
const ALL_ITEM_FIELDS = [...new Set<string>([...POLISH_ITEM_FIELDS.projects, ...POLISH_ITEM_FIELDS.experience])] as [PolishItemField, ...PolishItemField[]];

export const POLISH_ITEM_LIST_FIELDS: ReadonlySet<string> = new Set(["bullets", "techs"]);
/** 기간 칸: 근거 없는 숫자면 자리표시로 감쌀 공간이 없어(20자) 그 칸 변경을 버린다. */
export const POLISH_ITEM_DATE_FIELDS: ReadonlySet<string> = new Set(["startDate", "endDate"]);

export const isPolishItemField = (section: PolishItemSection, field: unknown): field is PolishItemField =>
  (POLISH_ITEM_FIELDS[section] as readonly unknown[]).includes(field);

export const POLISH_ITEM_SECTION_LABEL: Record<PolishItemSection, string> = { projects: "프로젝트", experience: "경력" };

const FIELD_LABELS: Record<PolishItemSection, Record<string, string>> = {
  projects: {
    name: "프로젝트 이름",
    company: "회사·활동",
    team: "팀 구성",
    role: "역할",
    startDate: "시작",
    endDate: "끝",
    summary: "요약",
    problem: "문제",
    action: "개선",
    result: "결과",
    bullets: "기여",
    techs: "기술",
  },
  experience: {
    company: "회사",
    department: "부서",
    title: "직무·직급",
    startDate: "시작",
    endDate: "끝",
    location: "지역",
    scope: "담당 범위",
    bullets: "대표 기여",
  },
};
export const polishItemFieldLabel = (section: PolishItemSection, field: string): string => FIELD_LABELS[section][field] ?? field;

type Bag = { _zod?: { bag?: { maximum?: number } }; maxLength?: number | null; element?: unknown; shape?: Record<string, unknown> };
const itemShape = (section: PolishItemSection) => ((ResumeDocumentSchema.shape[section] as unknown as Bag).element as Bag).shape!;

/** 섹션 항목 수 상한(ResumeDocumentSchema). */
export function polishItemSectionMax(section: PolishItemSection): number {
  return (ResumeDocumentSchema.shape[section] as unknown as Bag)._zod?.bag?.maximum ?? 20;
}

/** 칸 상한: 글 칸은 글자 수, 목록 칸은 줄 하나의 글자 수와 줄 수(ResumeDocumentSchema). */
export function polishItemFieldLimit(section: PolishItemSection, field: string): { maxChars: number; maxItems: number | null } {
  const schema = itemShape(section)[field] as Bag | undefined;
  if (!schema) return { maxChars: 0, maxItems: null };
  if (schema.element) return { maxChars: (schema.element as Bag).maxLength ?? 60, maxItems: schema._zod?.bag?.maximum ?? 15 };
  return { maxChars: schema.maxLength ?? 120, maxItems: null };
}

export type PolishItemValue = string | string[];
export type PolishItemRecord = Record<string, PolishItemValue>;

/** 항목의 칸 값(없으면 null). */
export function polishItemFieldValue(item: unknown, field: string): PolishItemValue | null {
  if (!item || typeof item !== "object") return null;
  const v = (item as Record<string, unknown>)[field];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return null;
}

/** 두 칸 값이 같은가(목록은 순서까지). */
export function samePolishItemValue(a: PolishItemValue | null | undefined, b: PolishItemValue | null | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** 화면 한 줄용 값("" / 목록은 줄바꿈으로 잇는다). */
export const polishItemValueText = (v: PolishItemValue | null | undefined): string => (Array.isArray(v) ? v.join("\n") : (v ?? ""));

/** 항목 이름(프로젝트 이름, 경력은 회사). */
function itemName(section: PolishItemSection, item: unknown): string {
  const v = polishItemFieldValue(item, section === "projects" ? "name" : "company");
  return typeof v === "string" ? v.trim() : "";
}

/** 화면용 항목 이름(예: "프로젝트 2 · 결제 개선"). */
export function polishItemLabel(doc: ResumeDocument, section: PolishItemSection, index: number): string {
  const name = itemName(section, doc[section][index]);
  return `${POLISH_ITEM_SECTION_LABEL[section]} ${index + 1}${name ? ` · ${name.slice(0, 30)}` : ""}`;
}

/** 칸 경로가 가리키는 항목("projects[1].problem" → {projects, 1, problem}). 항목 칸이 아니면 null. */
export function polishItemOfPath(path: string): { section: PolishItemSection; index: number; field: string; sub: number | null } | null {
  const m = /^(projects|experience)\[(\d{1,2})\]\.([a-zA-Z]+)(?:\[(\d{1,2})\])?$/.exec(path);
  if (!m) return null;
  return { section: m[1] as PolishItemSection, index: Number(m[2]), field: m[3]!, sub: m[4] === undefined ? null : Number(m[4]) };
}

/** 빈 새 항목(문서 스키마의 모든 칸). */
export function emptyPolishItem(section: PolishItemSection): PolishItemRecord {
  return (section === "projects" ? EMPTY_RESUME_ITEM.project() : EMPTY_RESUME_ITEM.experience()) as unknown as PolishItemRecord;
}

// ---------------------------------------------------------------------------
// LLM 출력
// ---------------------------------------------------------------------------

/** 항목 칸 하나의 새 값. 목록 칸(bullets·techs)은 한 줄에 하나. */
export const PolishItemChangeOutputSchema = z.object({
  field: z.enum(ALL_ITEM_FIELDS).describe("고칠 칸(프로젝트: name·company·team·role·startDate·endDate·summary·problem·action·result·bullets·techs / 경력: company·department·title·startDate·endDate·location·scope·bullets)"),
  value: z.string().describe("그 칸에 그대로 넣을 새 값. bullets·techs는 한 줄에 하나. 자료에 없는 수치는 [ADD: 수치 확인 — …], 모르는 사실은 [ADD: …]"),
});
export type PolishItemChangeOutput = z.input<typeof PolishItemChangeOutputSchema>;

/** 전체 이력서 모드의 항목 제안(LLM 출력). 대상·자리·before는 서버가 다시 정한다. */
export const PolishItemOutputSchema = z.object({
  kind: z.enum(["edit", "add"]).describe("edit: 있는 항목 하나의 여러 칸을 한 번에 고친다. add: 새 항목을 더한다(사용자가 추가를 요청했을 때만)"),
  section: z.enum(POLISH_ITEM_SECTIONS).describe("projects(프로젝트) 또는 experience(경력)"),
  index: z.number().int().describe("edit: 고칠 항목 번호(<polish_items>의 [projects[1]]이면 1). add: 넣을 자리(맨 뒤면 -1)"),
  changes: z.array(PolishItemChangeOutputSchema).describe("edit: 바꿀 칸만. add: 새 항목의 칸(아는 것만 — 모르는 핵심 칸은 [ADD: …])"),
  reason: z.string().describe("왜 이렇게 고치는지·더하는지 한 문장(40자 안팎)"),
});
export type PolishItemOutput = z.input<typeof PolishItemOutputSchema>;

/** 한 답변의 항목 제안 상한(칸 제안과 합쳐 MAX_DOC_SUGGESTIONS 안). */
export const MAX_DOC_ITEM_SUGGESTIONS = 3;

// ---------------------------------------------------------------------------
// 저장 형식(메시지 data)
// ---------------------------------------------------------------------------

export interface PolishItemChange {
  field: string;
  label: string;
  /** 제안 때 그 칸의 값(서버가 채운다). 추가는 빈 값. */
  before: PolishItemValue;
  after: PolishItemValue;
  /** 서버 검증이 표시하거나 뺀 값(근거 없는 숫자·기술·이름). */
  flagged: string[];
}

export interface PolishItemSuggestion {
  kind: "item-edit" | "item-add";
  section: PolishItemSection;
  /** item-edit: 고칠 항목 자리. item-add: 넣을 자리(제안 때 문서 기준 — 적용 때 길이를 넘으면 맨 뒤). */
  index: number;
  /** 화면용 이름(예: "프로젝트 2 · 결제 개선", "새 프로젝트 · 결제 개선"). */
  label: string;
  /** item-edit: 바꾸는 칸. item-add: 새 항목에서 값이 있는 칸(before는 빈 값). */
  changes: PolishItemChange[];
  /** item-add: 넣을 새 항목 전체(서버가 만든 것 — 스키마 검증을 거쳤다). */
  item?: PolishItemRecord;
  reason: string;
  /** changes[].flagged를 합친 것. */
  flagged: string[];
  /**
   * item-edit: 제안 때 대상 항목의 정체(polishItemAnchor — 이름·회사·직무·기간, 모두 비면 고치지 않는 칸 전체).
   * 순서를 바꾸거나 앞에 항목을 넣어 같은 자리에 다른 항목이 오면, 고칠 칸의 before가 같아도(빈 칸 채우기) stale·충돌로 본다.
   * 이 필드가 없는 예전 제안은 확인하지 않는다.
   */
  anchor?: PolishItemRecord;
}

export const isPolishItemSuggestion = (s: unknown): s is PolishItemSuggestion =>
  !!s && typeof s === "object" && ((s as { kind?: unknown }).kind === "item-edit" || (s as { kind?: unknown }).kind === "item-add");

/** 적용 때 뺄 칸(카드에서 체크를 푼 칸). 항목 고치기만 — 추가는 항목 전체를 넣는다. */
export const PolishItemExcludeSchema = z.array(z.string().max(20)).max(13);

// ---------------------------------------------------------------------------
// 문서 읽기·쓰기 (적용·화면 공용)
// ---------------------------------------------------------------------------

/** 항목 정체 칸: 프로젝트는 이름·회사·기간, 경력은 회사·직무·기간. */
const ANCHOR_FIELDS: Record<PolishItemSection, readonly string[]> = {
  projects: ["name", "company", "startDate", "endDate"],
  experience: ["company", "title", "startDate", "endDate"],
};

/**
 * 제안 때 항목의 정체 스냅샷(바꾸지 않는 정체 칸). 그 칸이 모두 비었으면(빈 항목 둘을 구별할 수 없다) 고치지 않는 칸 전체로 본다.
 * changed: 이 제안이 바꾸는 칸(그 칸은 before/after로 따로 확인한다).
 */
export function polishItemAnchor(section: PolishItemSection, item: unknown, changed: readonly string[]): PolishItemRecord {
  const pick = (fields: readonly string[]) =>
    Object.fromEntries(
      fields.flatMap((f) => {
        const v = polishItemFieldValue(item, f);
        return v === null ? [] : [[f, Array.isArray(v) ? [...v] : v]];
      }),
    ) as PolishItemRecord;
  // 바꾸는 칸은 빼고 본다: 그 칸은 before로 확인하고, 사용자가 그 칸만 고친 뒤 체크를 풀면 나머지를 적용할 수 있어야 한다.
  const ids = pick(ANCHOR_FIELDS[section].filter((f) => !changed.includes(f)));
  if (Object.values(ids).some((v) => polishItemValueText(v).trim())) return ids;
  return pick(POLISH_ITEM_FIELDS[section].filter((f) => !changed.includes(f)));
}

/**
 * 지금 항목이 제안 때 그 항목인가: 스냅샷의 모든 칸이 그대로다. 제안이 바꾸는 칸은 그 제안의 after여도 된다(적용한 뒤).
 * anchor가 없으면(예전 제안) 확인하지 않는다.
 */
export function polishItemAnchorMatches(
  cur: unknown,
  anchor: PolishItemRecord | undefined,
  afterOf: (field: string) => PolishItemValue | undefined = () => undefined,
): boolean {
  if (!anchor) return true;
  if (!cur) return false;
  return Object.entries(anchor).every(([f, v]) => {
    const now = polishItemFieldValue(cur, f);
    if (samePolishItemValue(now, v)) return true;
    const after = afterOf(f);
    return after !== undefined && samePolishItemValue(now, after);
  });
}

/**
 * 칸 제안(경로)의 항목 정체 확인: 경로가 프로젝트·경력 칸이고 anchor가 있으면 그 자리 항목이 제안 때 항목인가.
 * after: 그 칸 제안의 새 글(적용한 뒤 상태를 볼 때).
 */
export function polishPathAnchorMatches(doc: Pick<ResumeDocument, PolishItemSection>, path: string, anchor: PolishItemRecord | undefined, after?: string): boolean {
  if (!anchor) return true;
  const at = polishItemOfPath(path);
  if (!at) return true;
  return polishItemAnchorMatches(doc[at.section][at.index], anchor, (f) => (f === at.field && at.sub === null ? after : undefined));
}

const afterOfChanges = (s: PolishItemSuggestion) => (f: string) => s.changes.find((c) => c.field === f)?.after;

/** 적용할 칸(빼기를 반영). */
export function polishItemActiveChanges(s: PolishItemSuggestion, exclude: readonly string[] = []): PolishItemChange[] {
  if (s.kind === "item-add") return s.changes;
  const skip = new Set(exclude);
  return s.changes.filter((c) => !skip.has(c.field));
}

/** 이 제안의 지금 상태: live(적용 가능), applied(이미 반영됨), stale(제안 뒤 바뀜 — 적용 불가), full(추가할 자리 없음). */
export type PolishItemState = "live" | "applied" | "stale" | "full";

/**
 * applied: 이 제안을 이미 적용했다는 기록(메시지 data.applied)이 있는가. 추가는 기록이 있으면 늘 applied다 —
 * 추가한 항목을 사용자가 고치면(자리표시 이름을 채우는 등) 목록에서 알아볼 수 없어 다시 추가(중복)되기 때문이다.
 */
export function polishItemState(doc: Pick<ResumeDocument, PolishItemSection>, s: PolishItemSuggestion, applied = false): PolishItemState {
  const items = doc[s.section] as unknown[];
  if (s.kind === "item-add") {
    if (applied) return "applied";
    if (s.item && polishItemPresent(s.section, items, s.item)) return "applied";
    return items.length >= polishItemSectionMax(s.section) ? "full" : "live";
  }
  return polishItemEditState(items[s.index], s);
}

/** 항목 고치기 제안의 상태(대상 항목의 지금 값으로). 칸 모드 화면은 대상 항목 하나만 들고 있다. */
export function polishItemEditState(cur: unknown, s: PolishItemSuggestion): Exclude<PolishItemState, "full"> {
  if (!cur) return "stale";
  // 같은 자리에 다른 항목이 왔다(순서 바꾸기·앞에 추가) — before가 같아도 이 제안의 대상이 아니다.
  if (!polishItemAnchorMatches(cur, s.anchor, afterOfChanges(s))) return "stale";
  if (s.changes.every((c) => samePolishItemValue(polishItemFieldValue(cur, c.field), c.before))) return "live";
  // 체크를 풀고 적용한 칸은 그대로 before다 — 바꾼 칸이 after이고 나머지가 before면 적용한 것으로 본다.
  const done = s.changes.filter((c) => samePolishItemValue(polishItemFieldValue(cur, c.field), c.after));
  if (done.length > 0 && s.changes.every((c) => done.includes(c) || samePolishItemValue(polishItemFieldValue(cur, c.field), c.before))) return "applied";
  return "stale";
}

/** 바뀐 칸(충돌 목록용): 고칠 칸 중 지금 값이 제안 때 값과 다른 칸. */
export function polishItemConflicts(doc: ResumeDocument, s: PolishItemSuggestion, exclude: readonly string[] = []): PolishItemChange[] {
  if (s.kind === "item-add") return [];
  const cur = doc[s.section][s.index];
  // 같은 자리에 다른 항목이 왔으면 고칠 칸 전부가 충돌이다(빈 칸 채우기처럼 before가 같아도 다른 항목에 쓰지 않는다).
  if (!polishItemAnchorMatches(cur, s.anchor)) return polishItemActiveChanges(s, exclude);
  return polishItemActiveChanges(s, exclude).filter((c) => !cur || !samePolishItemValue(polishItemFieldValue(cur, c.field), c.before));
}

/** 자리표시가 아닌 실제 이름(없으면 ""). */
const realName = (name: string) => (/\[ADD:/.test(name) ? "" : name.replace(/\s+/g, " ").trim().toLowerCase());

/**
 * 새 항목이 이미 목록에 있는가: 모든 칸이 같거나, 자리표시가 아닌 이름(프로젝트 이름·경력 회사)이 같은 항목이 있다.
 * 추가한 뒤 그 항목을 고쳐도 다시 추가(중복)되지 않게 이름으로도 본다.
 */
export function polishItemPresent(section: PolishItemSection, items: readonly unknown[], item: PolishItemRecord): boolean {
  // 경력은 같은 회사에 직무가 여럿일 수 있어 회사 + 직무로 본다.
  const identity = (x: unknown) => {
    const name = realName(itemName(section, x));
    if (!name || section === "projects") return name;
    const title = realName(String(polishItemFieldValue(x, "title") ?? ""));
    return title ? `${name}|${title}` : "";
  };
  const id = identity(item);
  return items.some((x) => sameItem(x, item) || (id !== "" && identity(x) === id));
}

function sameItem(a: unknown, b: PolishItemRecord): boolean {
  return Object.keys(b).every((k) => samePolishItemValue(polishItemFieldValue(a, k), b[k]));
}

/** 항목 고치기를 반영한 새 문서(원본은 그대로). 항목이 없으면 null. 충돌 확인은 부르는 쪽이 먼저 한다. */
export function withPolishItemEdit(doc: ResumeDocument, s: PolishItemSuggestion, exclude: readonly string[] = []): ResumeDocument | null {
  if (s.kind !== "item-edit" || !doc[s.section][s.index]) return null;
  const next = structuredClone(doc);
  const item = next[s.section][s.index] as unknown as Record<string, unknown>;
  for (const c of polishItemActiveChanges(s, exclude)) item[c.field] = Array.isArray(c.after) ? [...c.after] : c.after;
  return next;
}

/**
 * 새 항목들을 넣은 새 문서. 자리는 제안 때 문서 기준이라 큰 자리부터 넣는다(앞에 넣은 항목이 뒤 자리를 밀지 않게).
 * 자리가 길이를 넘으면 맨 뒤. 같은 자리는 제안 순서대로.
 */
export function withPolishItemAdds(doc: ResumeDocument, adds: readonly PolishItemSuggestion[]): ResumeDocument {
  const next = structuredClone(doc);
  const order = adds.map((s, k) => ({ s, k })).sort((a, b) => b.s.index - a.s.index || b.k - a.k);
  for (const { s } of order) {
    if (s.kind !== "item-add" || !s.item) continue;
    const list = next[s.section] as unknown[];
    const at = Math.min(Math.max(0, s.index), list.length);
    list.splice(at, 0, structuredClone(s.item));
  }
  return next;
}
