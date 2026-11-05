/**
 * 한국 시간(KST, UTC+9) 날짜 유틸(클라이언트·서버 공용, 순수). 공고 마감·지원일·다음 일정은 모두 KST 달력 날짜
 * 'YYYY-MM-DD' 문자열로 다룬다. 서버(UTC)와 브라우저(어느 시간대든)에서 같은 답이 나오도록 로컬 시간대를 쓰지 않는다
 * (CareerLoop의 date.ts는 로컬 시간대를 써서 서버에서 날짜가 하루 어긋났다).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 실제로 있는 날짜의 'YYYY-MM-DD'인지(2월 30일 등은 거절). */
export function isValidKstDate(value: string | null | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** 'HH:mm'(00:00~23:59)인지. */
export function isValidKstTime(value: string | null | undefined): value is string {
  return !!value && TIME_RE.test(value);
}

/** 시각(ms 또는 Date)의 KST 달력 날짜. */
export function kstDate(at: number | Date = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 오늘(KST). */
export function kstToday(now: number | Date = Date.now()): string {
  return kstDate(now);
}

/** KST 날짜(+선택 시각)의 시작 시각(ms). 날짜가 틀리면 null. */
export function kstDateTimeToMs(date: string, time?: string | null): number | null {
  if (!isValidKstDate(date)) return null;
  const t = isValidKstTime(time) ? time : "00:00";
  return Date.parse(`${date}T${t}:00+09:00`);
}

/** from 날짜에서 to 날짜까지 남은 일수(같으면 0, 지났으면 음수). 둘 중 하나라도 틀리면 null. */
export function daysBetween(from: string, to: string): number | null {
  if (!isValidKstDate(from) || !isValidKstDate(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** 날짜에 일수를 더한다. 틀린 날짜는 그대로 돌려준다. */
export function addKstDays(date: string, days: number): string {
  if (!isValidKstDate(date)) return date;
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** "11월 5일"(withWeekday면 "11월 5일 (목)", withYear면 "2026년 11월 5일"). 틀린 날짜는 "날짜 미정". */
export function formatKstDate(date: string | null | undefined, opts: { withYear?: boolean; withWeekday?: boolean } = {}): string {
  if (!isValidKstDate(date)) return "날짜 미정";
  const d = new Date(`${date}T00:00:00Z`);
  const base = `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
  const head = opts.withYear ? `${d.getUTCFullYear()}년 ${base}` : base;
  return opts.withWeekday ? `${head} (${WEEKDAYS[d.getUTCDay()]})` : head;
}

/** "오늘", "내일", "모레", "3일 뒤", "2일 지남". */
export function relativeKstLabel(date: string | null | undefined, today: string = kstToday()): string {
  const diff = date ? daysBetween(today, date) : null;
  if (diff === null) return "날짜 미정";
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff === 2) return "모레";
  return diff > 0 ? `${diff}일 뒤` : `${-diff}일 지남`;
}
