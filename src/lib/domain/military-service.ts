/**
 * 병역특례(전문연구요원·산업기능요원) 가능 여부 태그(클라이언트·서버 공용, 순수). 판정은 src/lib/postings/military-service.ts.
 * shared_postings.military_service(text[])에 아래 코드로 저장하고, 공고 찾기 필터(military)는 이 배열로 거른다.
 * - expert: 전문연구요원 가능
 * - industrial: 산업기능요원 가능(복무 구분은 industrial_supplementary·industrial_active로 덧붙인다)
 * - general: '병역특례 가능'만 있고 종류(전문연·산업기능요원)가 적혀 있지 않음
 */
export const MILITARY_SERVICE_TAGS = ["expert", "industrial", "industrial_supplementary", "industrial_active", "general"] as const;
export type MilitaryServiceTag = (typeof MILITARY_SERVICE_TAGS)[number];

/** 공고 찾기 병역특례 필터: 전체 / 병역특례 가능(종류 무관) / 전문연구요원 / 산업기능요원. */
export const MILITARY_SERVICE_FILTERS = ["all", "any", "expert", "industrial"] as const;
export type MilitaryServiceFilter = (typeof MILITARY_SERVICE_FILTERS)[number];
export const MILITARY_SERVICE_FILTER_LABELS: Record<MilitaryServiceFilter, string> = {
  all: "병역특례 전체",
  any: "병역특례 가능",
  expert: "전문연 가능",
  industrial: "산업기능요원 가능",
};

/** 저장된 배열 → 알려진 태그만(순서 고정, 중복 없음). */
export function normalizeMilitaryTags(value: readonly unknown[] | null | undefined): MilitaryServiceTag[] {
  if (!value) return [];
  const set = new Set(value);
  return MILITARY_SERVICE_TAGS.filter((t) => set.has(t));
}

/** 화면 태그 문구("전문연 가능", "산업기능요원 가능(보충역)", "병역특례 가능"). 없으면 []. */
export function militaryServiceLabels(tags: readonly MilitaryServiceTag[] | null | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const has = (t: MilitaryServiceTag) => tags.includes(t);
  const out: string[] = [];
  if (has("expert")) out.push("전문연 가능");
  if (has("industrial")) {
    const duty = [has("industrial_active") ? "현역" : "", has("industrial_supplementary") ? "보충역" : ""].filter(Boolean).join("·");
    out.push(duty ? `산업기능요원 가능(${duty})` : "산업기능요원 가능");
  }
  if (out.length === 0 && has("general")) out.push("병역특례 가능");
  return out;
}
