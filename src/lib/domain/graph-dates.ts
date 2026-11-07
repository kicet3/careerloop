/**
 * 경험 그래프 날짜 계약(순수 — 클라이언트·서버 공용). 모든 쓰기 경로(직접 편집·그래프 채팅·문서 가져오기·GitHub 가져오기)는
 * planGraphOps(src/lib/graph/plan.ts)를 지나고, 거기서 이 정규화를 다시 강제한다. 읽기(getCareerGraph)도 저장된 옛 값을
 * 같은 규칙으로 보여 준다(normalizeStoredDates — 저장값은 다시 쓰지 않는다).
 *
 * 계약:
 * - 저장 형식은 'YYYY-MM'. 연도만 알면 'YYYY'. 일(day)까지 받아도 'YYYY-MM'으로 줄인다.
 * - 진행 중(현재·재직 중·진행 중 …)은 endDate에 쓰지 않고 current=true로 둔다(endDate는 비운다). 화면·이력서는 이것을 "현재"로 보인다.
 *   current와 실제 endDate가 함께 오면 current가 이기고 endDate는 뺀다(진행 중인 일을 '이번 달 종료'로 저장하던 문제).
 * - startDate ≤ endDate. 오늘(KST) 이후 날짜는 받지 않는다 — 학력 종료(졸업 예정)만 예외.
 * - 알아볼 수 없는 값은 그 속성만 빼고 사유를 남긴다(호출자가 후속 질문으로 바꾼다).
 */
import { kstToday } from "@/lib/time/kst";

/** 날짜 속성 키(라벨 공통 이름). Certification.date = 취득일, Achievement.date = 달성 시점. */
export const GRAPH_DATE_KEYS = ["startDate", "endDate", "date"] as const;
export type GraphDateKey = (typeof GRAPH_DATE_KEYS)[number];
const DATE_KEY_SET = new Set<string>(GRAPH_DATE_KEYS);
export const isGraphDateKey = (k: string): k is GraphDateKey => DATE_KEY_SET.has(k);

/** 진행 중 표시(current)를 가진 라벨 — endDate의 '현재'를 current=true로 바꾼다. */
export const ONGOING_LABELS = new Set(["Role", "Project", "Experience", "Education"]);
/** 오늘 이후 값을 허용하는 (라벨, 키): 졸업 예정. */
const FUTURE_OK = new Set(["Education.endDate"]);

/** 저장 형식(정규화 결과): YYYY 또는 YYYY-MM. */
export const STORED_DATE_RE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

export type GraphDateParse =
  | { kind: "date"; value: string }
  | { kind: "ongoing" }
  | { kind: "empty" }
  | { kind: "invalid" };

const MIN_YEAR = 1950;
const MAX_YEAR = 2100;

const ONGOING_RE =
  /^(?:~\s*)?(?:현재|지금|오늘|현재\s*까지|지금\s*까지|오늘\s*까지|진행\s*중|재직\s*중|재학\s*중|근무\s*중|참여\s*중|활동\s*중|운영\s*중|개발\s*중|현재\s*(?:진행|재직|재학|근무|참여|활동|운영|개발)\s*중?|계속|now|present|current|currently|ongoing|to\s*date|till\s*now|until\s*now|in\s*progress)(?:\s*~)?$/i;
/** 값이 없다는 뜻의 표기(빈 값으로 본다 — 지어내지 않는다). */
const EMPTY_RE = /^(?:[~\-–—?·.]+|모름|미정|없음|미상|n\/?a|none|unknown|tbd|null|undefined)$/i;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

function ym(year: number, month: number | null): string | null {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month === null) return String(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${pad(month)}`;
}

/** 두 자리 연도: 00~69 → 2000년대, 70~99 → 1900년대. */
const fullYear = (yy: string) => (yy.length === 4 ? Number(yy) : Number(yy) + (Number(yy) < 70 ? 2000 : 1900));

function validDay(year: number, month: number, day: number): boolean {
  if (day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1;
}

/**
 * 날짜 표기 하나 → 저장 형식. today(YYYY-MM-DD, KST)는 '작년 3월'·'올해'·'지난달' 같은 상대 표현을 풀 때만 쓴다.
 * 범위("2024.03 ~ 2024.06")·서술형 문장은 invalid다(속성 하나에 하나의 시점만).
 */
export function parseGraphDate(raw: unknown, opts: { today?: string } = {}): GraphDateParse {
  if (raw === null || raw === undefined) return { kind: "empty" };
  if (typeof raw === "number") return parseGraphDate(String(raw), opts);
  if (typeof raw !== "string") return { kind: "invalid" };
  const v = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (v === "") return { kind: "empty" };
  if (v.length > 40) return { kind: "invalid" };
  if (EMPTY_RE.test(v)) return { kind: "empty" };
  if (ONGOING_RE.test(v)) return { kind: "ongoing" };
  const s = v.replace(/^'/, "").replace(/\.$/, "").trim();
  const date = (y: number, mo: number | null) => {
    const out = ym(y, mo);
    return out ? ({ kind: "date", value: out } as const) : ({ kind: "invalid" } as const);
  };
  let m: RegExpExecArray | null;
  // ISO 날짜·시각: 2024-03-15, 2024-03-15T09:00:00Z
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? date(y, mo) : { kind: "invalid" };
  }
  // 2024.03.15 / 2024/3/15 / 2024. 3. 15 / 2024년 3월 15일 / 24.03.15
  if ((m = /^'?(\d{4}|\d{2})\s*(?:[./-]|년)\s*(\d{1,2})\s*(?:[./-]|월)\s*(\d{1,2})\s*일?\.?$/.exec(s))) {
    const [y, mo, d] = [fullYear(m[1]!), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? date(y, mo) : { kind: "invalid" };
  }
  // 2024-03 / 2024.3 / 2024/03 / 2024. 03 / 2024년 3월 / 24.03 / 24년 3월 / '24.03
  if ((m = /^'?(\d{4}|\d{2})\s*(?:[./-]|년)\s*(\d{1,2})\s*월?\.?$/.exec(s))) return date(fullYear(m[1]!), Number(m[2]));
  // 202403 / 20240315
  if ((m = /^(\d{4})(\d{2})(\d{2})?$/.exec(s))) {
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (m[3] && !validDay(y, mo, Number(m[3]))) return { kind: "invalid" };
    return date(y, mo);
  }
  // 03/2024, 3.2024
  if ((m = /^(\d{1,2})\s*[./-]\s*(\d{4})$/.exec(s))) return date(Number(m[2]), Number(m[1]));
  // Mar 2024, March 2024, Mar. 2024, 2024 Mar
  if ((m = /^([a-z]{3,9})\.?,?\s*(\d{4})$/i.exec(s)) && MONTHS[m[1]!.toLowerCase()]) return date(Number(m[2]), MONTHS[m[1]!.toLowerCase()]!);
  if ((m = /^(\d{4})\s*([a-z]{3,9})\.?$/i.exec(s)) && MONTHS[m[2]!.toLowerCase()]) return date(Number(m[1]), MONTHS[m[2]!.toLowerCase()]!);
  // 2024 / 2024년 / 2024년 상반기·초·봄 (연도만 확실하다)
  if ((m = /^(\d{4})\s*년?(?:\s*(?:상반기|하반기|초|초반|중반|말|후반|봄|여름|가을|겨울|[1-4]\s*분기|q[1-4]))?$/i.exec(s))) return date(Number(m[1]), null);
  // 상대 표현(오늘 기준): 올해·작년·재작년(+N월), 이번 달·지난달
  const today = opts.today && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : null;
  if (today) {
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7));
    if ((m = /^(올해|금년|작년|지난\s*해|재작년)(?:\s*(\d{1,2})\s*월)?$/.exec(s))) {
      const back = /재작년/.test(m[1]!) ? 2 : /작년|지난/.test(m[1]!) ? 1 : 0;
      return date(ty - back, m[2] ? Number(m[2]) : null);
    }
    if (/^(이번\s*달|이달)$/.test(s)) return date(ty, tm);
    if (/^(지난\s*달|저번\s*달)$/.test(s)) return tm === 1 ? date(ty - 1, 12) : date(ty, tm - 1);
  }
  return { kind: "invalid" };
}

/** 정규화한 값 비교용: 'YYYY'와 'YYYY-MM'이 섞이면 연도끼리만 비교한다. a < b면 음수. */
export function compareGraphDates(a: string, b: string): number {
  if (a.length === 4 || b.length === 4) return Number(a.slice(0, 4)) - Number(b.slice(0, 4));
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 값이 오늘(KST 달) 이후인가. 'YYYY'는 올해보다 뒤일 때만. */
export function isFutureGraphDate(value: string, today: string): boolean {
  return compareGraphDates(value, today.slice(0, 7)) > 0;
}

export type DateIssueReason = "format" | "future" | "order" | "ongoing-start";

export interface DateIssue {
  key: GraphDateKey;
  /** 사용자가(또는 LLM이) 준 원래 값. */
  value: string;
  reason: DateIssueReason;
}

/** 사유 → 문장(뺀 항목 사유·오류 메시지). */
export const DATE_ISSUE_TEXT: Record<DateIssueReason, string> = {
  format: "형식이 맞지 않아",
  future: "오늘 이후 날짜라",
  order: "시작이 종료보다 늦어",
  "ongoing-start": "시작 시점으로 쓸 수 없어",
};

const isRealDate = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * 연산 하나의 날짜 속성을 계약대로 맞춘다(순수). props는 바꾸지 않고 새 객체를 돌려준다.
 * - mode "add": 빈 값은 뺀다. "update": null은 '지우기'로 그대로 둔다.
 * - existing: 수정할 노드의 지금 속성(시작·종료 순서 검사와 current 정리에 쓴다). 새 노드면 생략.
 * - 형식·미래·순서가 틀린 값은 그 속성만 빼고 issues에 남긴다. 순서가 틀리면 이번 연산이 준 날짜를 뺀다.
 */
export function normalizeNodeDates(
  label: string,
  props: Readonly<Record<string, unknown>>,
  opts: { mode: "add" | "update"; existing?: Readonly<Record<string, unknown>> | null; today?: string },
): { props: Record<string, unknown>; issues: DateIssue[] } {
  const today = opts.today ?? kstToday();
  const out: Record<string, unknown> = { ...props };
  const issues: DateIssue[] = [];
  const ongoingOk = ONGOING_LABELS.has(label);
  const drop = (key: GraphDateKey, reason: DateIssueReason) => {
    issues.push({ key, value: String(props[key]).slice(0, 40), reason });
    delete out[key];
  };

  for (const key of GRAPH_DATE_KEYS) {
    if (!(key in props)) continue;
    const raw = props[key];
    if (raw === null || raw === undefined) {
      if (opts.mode === "add" || raw === undefined) delete out[key];
      continue;
    }
    const parsed = parseGraphDate(raw, { today });
    if (parsed.kind === "empty") {
      if (opts.mode === "update") out[key] = null;
      else delete out[key];
      continue;
    }
    if (parsed.kind === "invalid") {
      drop(key, "format");
      continue;
    }
    if (parsed.kind === "ongoing") {
      if (key === "endDate" && ongoingOk) {
        delete out[key];
        out.current = true;
      } else drop(key, key === "startDate" ? "ongoing-start" : "format");
      continue;
    }
    if (isFutureGraphDate(parsed.value, today) && !FUTURE_OK.has(`${label}.${key}`)) {
      drop(key, "future");
      continue;
    }
    out[key] = parsed.value;
  }

  if (ongoingOk) {
    const cur = opts.existing ?? {};
    if (out.current === true) {
      // 진행 중이면 종료일을 두지 않는다(같이 온 종료일은 '이번 달'을 종료로 적은 것으로 본다).
      if (isRealDate(out.endDate)) delete out.endDate;
      if (opts.mode === "update" && isRealDate(cur.endDate) && !("endDate" in out)) out.endDate = null;
    } else if (opts.mode === "update" && isRealDate(out.endDate) && cur.current === true && !("current" in out)) {
      // 종료일을 새로 주면 끝난 일이다.
      out.current = null;
    }
  }

  // 시작 ≤ 종료(이번 연산 값 우선, 없으면 지금 값). 지금 값이 옛 형식이어도 같은 규칙으로 읽는다.
  const effective = (key: "startDate" | "endDate"): string | null => {
    const v = key in out ? out[key] : opts.existing?.[key];
    if (!isRealDate(v)) return null;
    const p = parseGraphDate(v, { today });
    return p.kind === "date" ? p.value : null;
  };
  const start = effective("startDate");
  const end = out.current === true ? null : effective("endDate");
  if (start && end && compareGraphDates(start, end) > 0) {
    const given = (["startDate", "endDate"] as const).filter((k) => isRealDate(out[k]));
    for (const k of given.length > 0 ? given : []) drop(k, "order");
  }
  return { props: out, issues };
}

/**
 * 저장된 노드 속성(옛 형식 포함) → 계약대로 보이는 값(읽기 전용, 저장값은 바꾸지 않는다).
 * 'YYYY-MM-DD'·'2024.03' → 'YYYY-MM', endDate '현재' → current=true. 알아볼 수 없는 값은 그대로 둔다(지우지 않는다).
 */
export function normalizeStoredDates(label: string, props: Readonly<Record<string, unknown>>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  const set = (k: string, v: unknown) => {
    out ??= { ...props };
    if (v === undefined) delete out[k];
    else out[k] = v;
  };
  for (const key of GRAPH_DATE_KEYS) {
    const raw = props[key];
    if (typeof raw !== "string" || STORED_DATE_RE.test(raw)) continue;
    const p = parseGraphDate(raw);
    if (p.kind === "date") set(key, p.value);
    else if (p.kind === "ongoing" && key === "endDate" && ONGOING_LABELS.has(label)) {
      set("endDate", undefined);
      set("current", true);
    }
  }
  if (props.current === true && isRealDate(props.endDate) && ONGOING_LABELS.has(label)) set("endDate", undefined);
  return out ?? (props as Record<string, unknown>);
}

/**
 * 저장된 값 중 옛 형식(정규화하면 바뀌는 날짜)만 골라 그 정규화 값을 돌려준다 — 노드를 다음에 고칠 때 함께 다시 쓴다(멱등).
 * 알아볼 수 없는 값·진행 중 표기는 건드리지 않는다(사용자가 직접 고치게).
 */
export function legacyDateRewrites(props: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of GRAPH_DATE_KEYS) {
    const raw = props[key];
    if (typeof raw !== "string" || STORED_DATE_RE.test(raw)) continue;
    const p = parseGraphDate(raw);
    if (p.kind === "date") out[key] = p.value;
  }
  return out;
}

/**
 * 글에 나온 시점들(YYYY-MM, 연도만이면 YYYY) — "사용자가 이 기간을 말했는가"를 볼 때 쓴다(guardInheritedPeriods).
 * 상대 표현은 today가 있을 때만 푼다.
 */
export function datesMentioned(text: string, today?: string): Set<string> {
  const out = new Set<string>();
  const t = text.normalize("NFKC");
  const add = (y: number, mo: number | null) => {
    const v = ym(y, mo);
    if (v) out.add(v);
  };
  for (const m of t.matchAll(/(?<!\d)('?\d{4}|'?\d{2})\s*(?:[./-]|년)\s*(\d{1,2})(?!\d)/g)) add(fullYear(m[1]!.replace("'", "")), Number(m[2]));
  for (const m of t.matchAll(/(?<!\d)(\d{4})(?:\s*년)?(?![\d./-])/g)) add(Number(m[1]), null);
  if (today) {
    for (const m of t.matchAll(/(올해|금년|작년|지난\s*해|재작년)(?:\s*(\d{1,2})\s*월)?/g)) {
      const p = parseGraphDate(m[0], { today });
      if (p.kind === "date") out.add(p.value);
    }
  }
  return out;
}

/** 'YYYY-MM'(또는 'YYYY')가 글에 나온 시점에 있는가. 글에 연도만 나왔으면 같은 해면 있다고 본다(넉넉하게 — 막는 쪽이 아니라 근거 확인용). */
export function mentionedIn(value: string, mentioned: ReadonlySet<string>): boolean {
  return mentioned.has(value) || mentioned.has(value.slice(0, 4));
}

/** ISO 시각 → 그 시각의 KST 달('YYYY-MM'). 틀리면 null. */
export function kstMonthOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
