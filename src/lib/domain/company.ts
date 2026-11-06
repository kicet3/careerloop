/**
 * 회사 이름 정규화와 회사 필터(클라이언트·서버 공용, 순수). 공고 보관함·공고 찾기의 '회사' 필터가 쓴다.
 * - companyKey: 같은 회사를 같은 값으로 묶는다(앞뒤 공백·공백 차이, 법인 표기 (주)·주식회사·㈜·Inc.·Co., Ltd. 등, 대소문자, 전각 문자).
 *   공용 공고는 쓸 때 shared_postings.company_key에 저장하고(필터·회사 목록이 DB에서 거른다), 보관함은 서버가 읽을 때 계산한다.
 *   규칙을 바꾸면 마이그레이션에서 company_key를 NULL로 되돌린다 — 공고 찾기 목록이 앱 규칙으로 다시 채운다(지연 백필).
 * - 회사 키는 주소(?company=키&company=키, 쉼표 목록도 받는다)에 실린다. 키에는 공백·쉼표가 없고, companyKey(키) === 키다.
 * - 회사 목록(CompanyOption)은 키마다 공고 수와 가장 많이 쓰인 원래 표기(label)를 싣는다.
 */

/** 한 번에 고를 수 있는 회사 수(주소·쿼리 크기 상한). */
export const COMPANY_FILTER_MAX = 10;
/** 회사 목록 기본·최대 개수(공고 수 많은 순). */
export const COMPANY_OPTIONS_DEFAULT_LIMIT = 20;
export const COMPANY_OPTIONS_MAX_LIMIT = 50;
/** 회사 키 최대 길이(공고 회사 이름 상한과 같은 크기). */
const KEY_MAX = 200;

export interface CompanyOption {
  /** companyKey(회사 이름). 주소·필터 값. */
  key: string;
  /** 화면 표기: 이 키로 묶인 원래 이름 중 가장 많이 쓰인 것. */
  label: string;
  /** 이 회사의 공고 수(보관함: 내 공고 전체, 공고 찾기: 숨기지 않은 공용 공고). */
  count: number;
}

// 어디에 있어도 지우는 한국어·한자 법인 표기. ㈜(U+321C)는 NFKC로 "(주)", ㈱(U+3231)은 "(株)"가 된다.
const LEGAL_ANYWHERE = [
  /\(\s*(?:주|유|합|株|有)\s*\)/g,
  /(?:주식|유한책임|유한|합자|합명)\s*회사/g,
  /株式会社|有限会社/g,
];
// 끝에 붙는 영문 법인 표기(앞이 처음·공백·구두점일 때만 — "Zinc"의 "inc"는 지우지 않는다). 여러 개면 되풀이해 지운다("Co., Ltd.").
const LEGAL_SUFFIX = /(^|[\s,.&])(?:inc|incorporated|corp|corporation|co|ltd|limited|llc|l\.l\.c|plc|gmbh|pte|k\.k)\.?$/;
const EDGE_PUNCT = /^[\s,.·・&\-–—_/|:;]+|[\s,.·・&\-–—_/|:;]+$/g;

/**
 * 회사 이름 → 회사 키. NFKC(전각·㈜) → 소문자 → 한국어·한자 법인 표기 제거 → 끝의 영문 법인 표기 제거(되풀이) → 앞뒤 구두점 제거
 * → 공백·쉼표 제거. 지우고 나니 비면(이름이 '(주)'뿐 등) 원래 이름을 소문자·공백 제거로만 쓴다. 빈 이름은 "".
 * 같은 키를 다시 넣으면 그대로 나온다(주소에 실린 키를 다시 정규화해도 바뀌지 않는다).
 */
export function companyKey(name: string | null | undefined): string {
  if (!name) return "";
  const base = name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!base) return "";
  let key = stripLegalForms(base);
  // 공백을 지워 새로 붙은 표기("주식, 회사" → "주식회사")까지 지운다 — 키를 다시 넣어도 같은 값이 나오게.
  for (let i = 0; i < 3; i++) {
    const next = stripLegalForms(key);
    if (next === key) break;
    key = next;
  }
  return (key || base.replace(/[\s,]+/g, "")).slice(0, KEY_MAX);
}

function stripLegalForms(value: string): string {
  let s = value;
  for (let i = 0; i < 4; i++) {
    const before = s;
    for (const re of LEGAL_ANYWHERE) s = s.replace(re, " ");
    s = s.replace(EDGE_PUNCT, "");
    while (LEGAL_SUFFIX.test(s)) s = s.replace(LEGAL_SUFFIX, "$1").replace(EDGE_PUNCT, "");
    if (s === before) break;
  }
  return s.replace(/[\s,]+/g, "");
}

/** 이름이 법인 표기뿐인지("(주)", "Ltd.", "Co." 등 — 지우면 아무것도 남지 않는다). */
function isLegalFormOnly(name: string): boolean {
  const base = name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return !!base && !stripLegalForms(base);
}

/** 주소의 ?company= 값(여러 개 또는 쉼표 목록) → 회사 키 목록(정규화·중복 제거·상한). 원래 이름을 넣어도 키로 바뀐다. */
export function parseCompanyParam(value: string | readonly string[] | undefined | null): string[] {
  if (!value) return [];
  // 쉼표 목록의 조각 중 법인 표기뿐인 것("Samsung Electronics Co., Ltd."의 " Ltd.")은 회사가 아니므로 버린다.
  const raw = (typeof value === "string" ? [value] : value).flatMap((v) => {
    const parts = v.split(",");
    return parts.length > 1 ? parts.filter((p) => !isLegalFormOnly(p)) : parts;
  });
  const out: string[] = [];
  for (const v of raw) {
    const key = companyKey(v.slice(0, KEY_MAX));
    if (key && !out.includes(key)) out.push(key);
    if (out.length >= COMPANY_FILTER_MAX) break;
  }
  return out;
}

/** 회사 키 목록 → 주소 쿼리에 붙인다(company=키 여러 번). 순서는 고른 순서. */
export function appendCompanyParams(params: URLSearchParams, keys: readonly string[] | undefined): void {
  for (const k of parseCompanyParam(keys ?? [])) params.append("company", k);
}

/** 회사 목록 검색어(공백·법인 표기 차이를 무시하고 키의 부분 일치로 찾는다). */
export function companySearchKey(q: string): string {
  return companyKey(q.slice(0, 100));
}

/** 회사 이름별 공고 수 → 회사 키별 목록(원래 표기 중 가장 많이 쓰인 것을 label로, 같으면 가나다순 앞의 것). 정렬하지 않는다. */
export function groupCompanyNames(rows: readonly { company: string; count: number }[]): Map<string, CompanyOption> {
  const byKey = new Map<string, { count: number; labels: Map<string, number> }>();
  for (const r of rows) {
    const key = companyKey(r.company);
    if (!key) continue;
    const label = r.company.replace(/\s+/g, " ").trim();
    const g = byKey.get(key) ?? { count: 0, labels: new Map<string, number>() };
    g.count += r.count;
    g.labels.set(label, (g.labels.get(label) ?? 0) + r.count);
    byKey.set(key, g);
  }
  const out = new Map<string, CompanyOption>();
  for (const [key, g] of byKey) {
    const label = [...g.labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"))[0][0];
    out.set(key, { key, label, count: g.count });
  }
  return out;
}

/** 공고 수 많은 순, 같으면 표기 가나다순. */
export function sortCompanyOptions(options: CompanyOption[]): CompanyOption[] {
  return options.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko") || (a.key < b.key ? -1 : 1));
}

/** 목록 개수(쿼리 ?limit=) → 1..COMPANY_OPTIONS_MAX_LIMIT. */
export function clampCompanyLimit(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n) || n < 1) return COMPANY_OPTIONS_DEFAULT_LIMIT;
  return Math.min(n, COMPANY_OPTIONS_MAX_LIMIT);
}
