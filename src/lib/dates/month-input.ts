/**
 * 월 입력 칸(MonthInput·달력 버튼) 공용 순수 함수 — 클라이언트·서버·테스트 공용.
 * 읽는 규칙은 그래프 날짜 계약(src/lib/domain/graph-dates.ts의 parseGraphDate)을 그대로 쓴다: "2024.2"·"24.02"·"2024년 2월"·
 * "2024/02"·"202402" → 2024년 2월, "현재"·"재직 중" → 진행 중, 13월·서술형은 알아볼 수 없음.
 * 쓰는 형식만 칸마다 다르다: 'dash' = YYYY-MM(경험 그래프 노드), 'dot' = YYYY.MM(이력서 문서, draft-rules와 같다).
 */
import { parseGraphDate } from "@/lib/domain/graph-dates";

export type MonthFormat = "dash" | "dot";

/** 이력서 문서·화면에서 진행 중을 나타내는 값. */
export const CURRENT_TEXT = "현재";

/** 알아볼 수 없을 때 보이는 안내. */
export const MONTH_HINT: Record<MonthFormat, string> = { dash: "예: 2024-02", dot: "예: 2024.02" };

export type MonthInputParse =
  | { kind: "empty" }
  /** value는 format에 맞춘 값(연도만 알면 'YYYY'). */
  | { kind: "date"; value: string; year: number; month: number | null }
  | { kind: "current" }
  | { kind: "invalid" };

const pad = (n: number) => String(n).padStart(2, "0");

/** 연·월 → 칸 형식. month가 없으면 연도만. */
export function formatMonth(year: number, month: number | null, format: MonthFormat): string {
  if (month === null) return String(year);
  return `${year}${format === "dash" ? "-" : "."}${pad(month)}`;
}

/** 입력 글 → 해석 결과(형식에 맞춘 값 포함). 상대 표현('작년 3월')은 풀지 않는다 — 칸에는 확실한 값만 바꿔 넣는다. */
export function parseMonthInput(raw: string, format: MonthFormat): MonthInputParse {
  const p = parseGraphDate(raw);
  if (p.kind === "empty") return raw.trim() === "" ? { kind: "empty" } : { kind: "invalid" };
  if (p.kind === "ongoing") return { kind: "current" };
  if (p.kind === "invalid") return { kind: "invalid" };
  const year = Number(p.value.slice(0, 4));
  const month = p.value.length > 4 ? Number(p.value.slice(5, 7)) : null;
  return { kind: "date", value: formatMonth(year, month, format), year, month };
}

/**
 * 칸을 떠날 때(blur) 쓸 값. 알아본 값은 형식대로, 진행 중은 allowCurrent면 CURRENT_TEXT, 알아볼 수 없으면 입력한 그대로(앞뒤 공백만 뺀다).
 * recognized=false면 칸 아래에 MONTH_HINT를 보인다.
 */
export function normalizeMonthInput(
  raw: string,
  format: MonthFormat,
  opts: { allowCurrent?: boolean } = {},
): { value: string; current: boolean; recognized: boolean } {
  const p = parseMonthInput(raw, format);
  if (p.kind === "empty") return { value: "", current: false, recognized: true };
  if (p.kind === "date") return { value: p.value, current: false, recognized: true };
  if (p.kind === "current" && opts.allowCurrent) return { value: CURRENT_TEXT, current: true, recognized: true };
  return { value: raw.trim(), current: false, recognized: false };
}

/** 칸 값이 알아볼 수 없는 글인가(빈 값·진행 중 허용 시 '현재'는 괜찮다). */
export function isUnrecognizedMonth(raw: string, format: MonthFormat, opts: { allowCurrent?: boolean } = {}): boolean {
  return !normalizeMonthInput(raw, format, opts).recognized;
}

/** 칸 값 → 달력에서 고를 연·월(<input type="month">의 'YYYY-MM'). 연·월을 다 알 때만. */
export function toPickerMonth(raw: string): { year: number; month: number } | null {
  const p = parseMonthInput(raw, "dash");
  return p.kind === "date" && p.month !== null ? { year: p.year, month: p.month } : null;
}

/** <input type="month"> 값('YYYY-MM') → 칸 형식. 틀리면 null. */
export function fromPickerValue(v: string, format: MonthFormat): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(v);
  return m ? formatMonth(Number(m[1]), Number(m[2]), format) : null;
}

/** 연·월 → <input type="month"> 값. */
export const pickerValue = (year: number, month: number) => `${year}-${pad(month)}`;

/** 달력 격자 방향키 이동: 3열 × 4행. 범위를 넘으면 해를 넘긴다(1월에서 ← → 전년 12월). */
export function moveMonth(year: number, month: number, key: string): { year: number; month: number } | null {
  const step =
    key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -3 : key === "ArrowDown" ? 3 : key === "PageUp" ? -12 : key === "PageDown" ? 12 : 0;
  if (key === "Home") return { year, month: 1 };
  if (key === "End") return { year, month: 12 };
  if (step === 0) return null;
  const idx = year * 12 + (month - 1) + step;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}
