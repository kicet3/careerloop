/**
 * 사실 주장 추출·정규화(§8.4, 순수). 답 segment의 수치·날짜·이름 후보가 인용한 근거 본문 합집합에 있는지 결정적으로 본다.
 * 정규화: NFKC(전각→반각), 소문자, 공백·쉼표 제거. 날짜는 YYYY-MM으로 맞춘다("2021.03" = "2021-03" = "2021년 3월").
 * 한계(§13-4): 사전에 없는 한국어 고유명사, 의미 왜곡은 잡지 못한다.
 */
import { rawTokens } from "@/lib/graph/retrieve";
import { canonicalSkill, skillKey } from "@/lib/skills/dictionary";

export interface Claims {
  numbers: string[];
  dates: string[];
  names: string[];
}

export function normalizeText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s,⁠]+/g, "");
}

const DATE_RES: RegExp[] = [
  /((?:19|20)\d{2})\s*년\s*(\d{1,2})\s*월/g,
  /((?:19|20)\d{2})[.\-/](\d{1,2})(?![\d])/g,
];
const YEAR_RE = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;
/**
 * 수치 토큰: 값 + 단위(있으면). 숫자 경계(앞뒤에 숫자·소수점이 붙지 않음)를 지키고, 단위까지 한 토큰으로 본다 —
 * "5명"이 "15명"에, "30%"가 "130%"에, "5회"가 날짜 숫자에 맞지 않게. 한글 단위는 목록(긴 것 먼저), 라틴 단위는 숫자에 붙은 1~5자(TPS·ms·x).
 * 단위 목록에 없는 한글이 바로 붙으면(조사 등) 단위 없는 수치다 — 단위 없는 수치는 근거의 같은 단위 없는 수치와만 맞는다.
 */
const NUMBER_RE =
  /(?<![\d.,])((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\d])(?:\s?(%|개월|시간|주년|퍼센트|배|명|건|억|만|천|원|초|년|분|개|회|일|주|월|차|달|번|위|점|권|편|곳|종|대|줄|장|팀|사)|([A-Za-z]{1,5})(?![A-Za-z]))?/g;

/** 수치 토큰 정규화: 쉼표 제거, 단위 소문자("퍼센트"→"%"). */
function numberToken(value: string, unit: string | undefined): string {
  const u = (unit ?? "").toLowerCase();
  return `${value.replace(/,/g, "")}${u === "퍼센트" ? "%" : u}`;
}

function takeNumbers(rest: string): string[] {
  const out: string[] = [];
  for (const m of rest.normalize("NFKC").matchAll(NUMBER_RE)) out.push(numberToken(m[1]!, m[2] ?? m[3]));
  return out;
}

/** 텍스트의 날짜(YYYY-MM, 연도만이면 YYYY)와 날짜를 지운 나머지. */
function takeDates(text: string): { dates: string[]; rest: string } {
  const dates: string[] = [];
  let rest = text.normalize("NFKC");
  for (const re of DATE_RES) {
    rest = rest.replace(re, (_m, y: string, mo: string) => {
      const m = Number(mo);
      if (m >= 1 && m <= 12) {
        dates.push(`${y}-${String(m).padStart(2, "0")}`);
        return " ";
      }
      return _m;
    });
  }
  rest = rest.replace(YEAR_RE, (_m, y: string) => {
    dates.push(y);
    return " ";
  });
  return { dates, rest };
}

/**
 * 이름 후보: (a) 본인 스냅샷 노드 제목 사전, (b) canonicalSkill이 아는 기술명, (c) 라틴 대문자로 시작하는 토큰(2자 이상)·따옴표 안 문자열.
 */
export function extractClaims(text: string, titles: readonly string[] = []): Claims {
  const { dates, rest } = takeDates(text);
  const numbers = takeNumbers(rest);
  const names = new Set<string>();
  const flat = normalizeText(text);
  for (const t of titles) {
    const n = normalizeText(t);
    if (n.length >= 2 && flat.includes(n)) names.add(t);
  }
  for (const tok of rawTokens(text)) {
    const c = canonicalSkill(tok);
    if (c) names.add(c);
  }
  for (const m of text.normalize("NFKC").matchAll(/(?<![A-Za-z])[A-Z][A-Za-z0-9+#.]+/g)) names.add(m[0].replace(/\.$/, ""));
  for (const m of text.matchAll(/["“「『']([^"”」』']{2,40})["”」』']/g)) names.add(m[1]!);
  return { numbers: [...new Set(numbers)], dates: [...new Set(dates)], names: [...names] };
}

/** 근거 본문 합집합의 비교용 색인. */
export interface EvidenceIndex {
  flat: string;
  /** 근거의 수치 토큰(날짜를 지운 뒤 같은 추출기로, 값+단위). */
  numbers: Set<string>;
  dates: Set<string>;
  years: Set<string>;
  skills: Set<string>;
}

export function indexEvidence(contents: readonly string[]): EvidenceIndex {
  const joined = contents.join("\n");
  const { dates, rest } = takeDates(joined);
  const skills = new Set<string>();
  for (const tok of rawTokens(joined)) {
    const c = canonicalSkill(tok);
    if (c) skills.add(skillKey(c));
  }
  return {
    flat: normalizeText(joined),
    numbers: new Set(takeNumbers(rest)),
    dates: new Set(dates),
    years: new Set([...dates].map((d) => d.slice(0, 4))),
    skills,
  };
}

/** 주장 하나라도 근거에 없으면 그 주장(사유용)을 돌려준다. 모두 있으면 null. */
export function unsupportedClaim(claims: Claims, ev: EvidenceIndex): string | null {
  for (const d of claims.dates) {
    if (d.length === 4 ? !ev.years.has(d) && !ev.flat.includes(d) : !ev.dates.has(d)) return "date";
  }
  for (const n of claims.numbers) {
    if (!numberSupported(n, ev)) return "number";
  }
  for (const name of claims.names) {
    const c = canonicalSkill(name);
    if (c && ev.skills.has(skillKey(c))) continue;
    if (!ev.flat.includes(normalizeText(name))) return "name";
  }
  return null;
}

/**
 * 수치 토큰 하나가 근거에 있는가 — 부분 문자열 비교를 하지 않는다("5명" ≠ "15명", "30%" ≠ "130%").
 * 값+단위가 같은 토큰이 있거나, 단위 있는 주장이면 근거의 같은 값 단위 없는 토큰(속성값 "teamSize=5")도 인정한다.
 * "3월"처럼 연도 없는 달은 근거 날짜(YYYY-MM)의 달과 맞춘다. 단위 없는 주장은 단위 없는 같은 값과만 맞는다.
 */
function numberSupported(token: string, ev: EvidenceIndex): boolean {
  if (ev.numbers.has(token)) return true;
  const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(token);
  if (!m) return false;
  const [, value, unit] = m;
  if (!unit) return false;
  if (unit === "월" && /^\d{1,2}$/.test(value!)) {
    const mm = `-${value!.padStart(2, "0")}`;
    if ([...ev.dates].some((d) => d.endsWith(mm))) return true;
  }
  return ev.numbers.has(value!);
}

export const hasClaims = (c: Claims) => c.numbers.length + c.dates.length + c.names.length > 0;
