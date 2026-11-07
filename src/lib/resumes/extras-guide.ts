/**
 * 이력서 '수상·기타'(extras) 작성 기준 — 단일 초안(draft.ts)과 그래프 에이전트(resume-agent/prompts.ts·verify.ts)가 함께 쓴다(순수).
 *
 * 근거: 국내 개발자 이력서 가이드·공개 이력서 조사(원티드 2023.01 이력서 가이드, 요즘IT 3113, 인프런 블로그 2119,
 * awesome-korean-resume와 공개 이력서 저장소, 코멘토 수상·병역 Q&A, 비즈폼·사람인 작성 도움말).
 * - 카테고리별 한 줄 형식, 넣을 것·뺄 것, 경력자/신입 순서, 묶음 규칙(빈 묶음 생략, 2개 이하면 '수상·기타' 하나, 묶음 안 최신순).
 * - 프롬프트 문구(EXTRAS_GUIDE_PROMPT_LINES)와 결정적 정리(normalizeExtras·isTrivialExtra·extrasMissingQuestions)를 같은 표에서 만든다.
 */
import type { ResumeDocument } from "@/lib/domain/resumes";

export type ResumeExtras = ResumeDocument["extras"];

export const EXTRAS_CATEGORY_IDS = [
  "award",
  "activity",
  "training",
  "language",
  "talk",
  "opensource",
  "mentoring",
  "certification",
  "military",
  "writing",
  "patent",
  "volunteer",
  "interest",
] as const;
export type ExtrasCategoryId = (typeof EXTRAS_CATEGORY_IDS)[number];

export interface ExtrasCategory {
  id: ExtrasCategoryId;
  /** 묶음 제목(기본값). */
  title: string;
  /** 한 줄 형식. */
  format: string;
  /** 쓸 때 주의(한 줄). */
  note: string;
  /** 묶음 제목·항목에서 카테고리를 알아보는 말(결정적 분류용). */
  match: RegExp;
}

export const EXTRAS_CATEGORIES: Record<ExtrasCategoryId, ExtrasCategory> = {
  award: {
    id: "award",
    title: "수상",
    format: "YYYY.MM 대회명 – 상 이름 (주최) · 프로젝트/역할",
    note: "지원 직무와 관련된 공식 수상만. 고교 수상·직무 무관 수상은 뺀다.",
    match: /(수상|입상|대상|최우수|우수상|장려상|금상|은상|동상|award|해커톤|공모전|경진대회)/i,
  },
  activity: {
    id: "activity",
    title: "대외활동",
    format: "YYYY.MM ~ YYYY.MM 활동명 (기수) · 역할",
    note: "신입에게 중요. 직무와 이어지는 1~2개만.",
    match: /(대외\s*활동|동아리|기수|서포터즈|학회|커뮤니티\s*활동)/,
  },
  training: {
    id: "training",
    title: "교육",
    format: "YYYY.MM ~ YYYY.MM 과정명 (기관) 수료",
    note: "부트캠프·직무 교육. 과정 중 수상은 수상에 쓴다. 경력자는 최근 1~2개만.",
    match: /(교육|부트캠프|수료|아카데미|bootcamp)/i,
  },
  language: {
    id: "language",
    title: "어학",
    format: "시험명 점수 (YYYY.MM) · 회화 수준",
    note: "점수·취득 시기는 자료에 있을 때만.",
    match: /(어학|TOEIC|TOEFL|OPIc|IELTS|TEPS|JLPT|HSK|토익|토플|오픽|회화)/i,
  },
  talk: {
    id: "talk",
    title: "발표",
    format: "행사명 YYYY – 「발표 제목」 (링크)",
    note: "연사·발표만. 단순 참석은 뺀다.",
    match: /(발표|강연|연사|세미나\s*발표|컨퍼런스|콘퍼런스|밋업|meetup|talk)/i,
  },
  opensource: {
    id: "opensource",
    title: "오픈소스",
    format: "org/repo – 기여 한 줄 (PR, 기간)",
    note: "머지된 기여·메인테이너 역할 위주.",
    match: /(오픈소스|open\s*source|컨트리뷰|contribut|github\.com\/|PR\s*#\d+|\bPR\b[^\n]{0,20}(머지|merge|병합|반영))/i,
  },
  mentoring: {
    id: "mentoring",
    title: "멘토링·커뮤니티",
    format: "YYYY 프로그램명 멘토(리뷰어·운영진)",
    note: "경력자에게 의미 있다.",
    match: /(멘토|멘토링|리뷰어|운영진|스터디\s*리더|코치)/,
  },
  certification: {
    id: "certification",
    title: "자격증",
    format: "YYYY.MM 자격증명 (발급 기관)",
    note: "자격 섹션이 따로 없을 때만 여기에. 직무와 관련 없는 자격(운전면허·워드·ITQ·한국사 등, 개발직 기준)은 뺀다.",
    match: /(자격증|자격|산업기사|정보처리기사|AWS\s*Certified|SQLD|SQLP|ADsP|CKA)/i,
  },
  military: {
    id: "military",
    title: "병역",
    format: "병역: 육군 병장 만기전역 (YYYY.MM ~ YYYY.MM) / 산업기능요원 / 면제",
    note: "신입 남성은 사실상 필수, 경력자는 선택. 군별·계급·기간·병과 정도만, 복무 중 일화는 쓰지 않는다.",
    match: /(병역|만기\s*전역|(육|해|공)군|해병|병장|산업기능요원|전문연구요원|군\s*면제|군필|미필)/,
  },
  writing: {
    id: "writing",
    title: "기고·블로그",
    format: "블로그: URL – 대표 글 1~2개",
    note: "머리글 링크와 겹치면 뺀다.",
    match: /(블로그|기고|칼럼|아티클|velog|tistory|medium\.com|brunch)/i,
  },
  patent: {
    id: "patent",
    title: "특허·논문",
    format: "YYYY.MM 「제목」 (학회·저널·출원번호) · 역할",
    note: "연구·ML 직무에서 더 중요.",
    match: /(특허|논문|학회|저널|journal|paper|출원|등록번호)/i,
  },
  volunteer: {
    id: "volunteer",
    title: "봉사",
    format: "YYYY.MM ~ YYYY.MM 봉사 활동명 (기관) · 역할",
    note: "신입만, 직무와 관련 있을 때만.",
    match: /(봉사|volunteer)/i,
  },
  interest: {
    id: "interest",
    title: "관심 분야",
    format: "관심 기술: 주제 – 한 줄",
    note: "권장하지 않는다. 직무와 이어지는 기술적 관심사만.",
    match: /(관심\s*(분야|기술|사|주제)|취미)/,
  },
};

/** 경력자 순서(빈 카테고리는 생략). */
export const EXTRAS_ORDER_EXPERIENCED: readonly ExtrasCategoryId[] = [
  "talk",
  "writing",
  "opensource",
  "award",
  "mentoring",
  "training",
  "language",
  "certification",
  "patent",
  "military",
  "activity",
  "volunteer",
  "interest",
];

/** 신입 순서. */
export const EXTRAS_ORDER_NEWCOMER: readonly ExtrasCategoryId[] = [
  "training",
  "award",
  "activity",
  "opensource",
  "language",
  "certification",
  "talk",
  "writing",
  "patent",
  "volunteer",
  "military",
  "mentoring",
  "interest",
];

/** 넣지 않는 것(프롬프트용). */
export const EXTRAS_EXCLUDE: readonly string[] = [
  "직무와 관련 없는 수상·자격증·아르바이트",
  "너무 오래된 경험(고교 시절 등)",
  "경력·프로젝트에 이미 쓴 내용의 반복",
  "사소한 작업 일화·소감(예: '툴을 1일 만에 만듦', '많이 배웠다')",
  "맥락 없는 링크",
  "개인 신상(가족·나이·종교·결혼)",
  "직무와 무관한 취미·게임",
  "단순 참석(발표·수상·운영 없이 행사에 간 것)",
  "기타가 경력보다 길어지는 분량",
  "허위·과장(자료에 없는 점수·순위·기간)",
];

/** 항목이 2개 이하면 한 묶음으로 합칠 때 쓰는 제목. */
export const EXTRAS_MERGED_TITLE = "수상·기타";
/** 묶음 수 상한(스키마 8). */
const MAX_GROUPS = 8;
/** 묶음 안 항목 상한(스키마 15). */
const MAX_ITEMS = 15;

/** 단일 초안·에이전트 사실 규칙 9번(RESUME_FACT_RULES)으로 들어가는 문구. */
export const EXTRAS_GUIDE_PROMPT_LINES: readonly string[] = [
  "9. extras(수상·기타)와 certifications는 채용 담당자가 의미 있게 볼 항목만, 자료에 있는 사실로만 넣는다(한국 개발자 이력서 관행 기준):",
  "   - 카테고리와 한 줄 형식(extras[].title은 묶음 제목, items는 한 줄씩):",
  ...EXTRAS_CATEGORY_IDS.filter((id) => id !== "interest").map((id) => {
    const c = EXTRAS_CATEGORIES[id];
    return `     · ${c.title}: "${c.format}" — ${c.note}`;
  }),
  `   - 넣지 않는 것: ${EXTRAS_EXCLUDE.join(", ")}.`,
  `   - 묶음 순서: 경력자 = ${orderText(EXTRAS_ORDER_EXPERIENCED)} / 신입 = ${orderText(EXTRAS_ORDER_NEWCOMER)}. 빈 묶음은 만들지 않는다.`,
  `   - 전체 항목이 2개 이하면 묶음을 나누지 않고 '${EXTRAS_MERGED_TITLE}' 한 묶음으로 쓴다. 묶음 안은 최신순.`,
  "   - 날짜·점수·순위·기관명은 자료에 있을 때만 쓴다. 형식에 필요한 값이 없으면 그 칸만 `[ADD: …]`로 둔다.",
  "   - 흔히 쓰는 정보(수상·어학 점수, 신입이면 교육 이수·병역)가 자료에 없으면 지어내지 말고 missingInfo에 '○○이 있으면 알려 주세요' 질문으로 남긴다.",
  "   - 넣을 만한 항목이 없으면 빈 배열로 둔다. 칸을 채우려고 억지로 넣지 않는다.",
];

function orderText(order: readonly ExtrasCategoryId[]): string {
  return order
    .filter((id) => id !== "interest" && id !== "volunteer")
    .map((id) => EXTRAS_CATEGORIES[id].title)
    .join(" > ");
}

// ---------------------------------------------------------------------------
// 결정적 판정·정리
// ---------------------------------------------------------------------------

/** 사소한 작업 일화·소감. 수상·발표·오픈소스·특허처럼 실적이 분명한 줄에는 적용하지 않는다('해커톤 대상 (48시간 만에 MVP)'). */
const ANECDOTE_RE = [
  /\d+\s*(일|시간|분)\s*만에/, // '툴을 1일 만에 만듦'
  /(만들어\s*(봄|봤|보았)|해\s*(봄|봤|보았))/,
  /(소감|느꼈|느낀\s*점|배웠|배운\s*점|보람|뿌듯|재미있|즐거웠|성장할\s*수\s*있었)/,
];
/** 개인 신상·무관한 취미(어떤 줄이든 뺀다). */
const PERSONAL_RE = /(가족|종교|결혼|기혼|미혼|게임\s*(랭크|티어|레벨))/;
/** 실적이 분명한 줄: 수상·입상·순위, 발표·강연, 오픈소스 기여, 특허·논문(행사 이름만 있는 '해커톤·컨퍼런스 참가'는 아니다). */
const ACHIEVEMENT_RE = /(수상|입상|대상|최우수|우수상|장려상|금상|은상|동상|award|\d+\s*위\b|발표|강연|연사|특허|논문|출원|등록번호)/i;
const ATTEND_ONLY_RE = /(참석|청강|참관)/;
const ATTEND_OK_RE = /(발표|연사|수상|입상|운영|멘토|스태프|주최)/;

/** 사소한 일화·소감·신상·단순 참석(결정적으로 빼는 기타 줄). 수상·발표·오픈소스·특허·운영 줄은 일화가 붙어 있어도 남긴다(신상은 뺀다). */
export function isTrivialExtra(text: string): boolean {
  const t = text.replace(/\[ADD:[^\]]*\]/g, " ").trim();
  if (!t) return false;
  if (PERSONAL_RE.test(t)) return true;
  const achievement = ATTEND_OK_RE.test(t) || ACHIEVEMENT_RE.test(t) || EXTRAS_CATEGORIES.opensource.match.test(t);
  if (achievement) return false;
  if (ANECDOTE_RE.some((re) => re.test(t))) return true;
  return ATTEND_ONLY_RE.test(t);
}

/** 묶음 제목(없으면 항목)으로 카테고리를 고른다. 모르면 null. */
export function classifyExtra(title: string, items: readonly string[] = []): ExtrasCategoryId | null {
  for (const text of [title, ...items]) {
    if (!text.trim()) continue;
    const hit = EXTRAS_CATEGORY_IDS.find((id) => EXTRAS_CATEGORIES[id].match.test(text));
    if (hit) return hit;
  }
  return null;
}

/** 줄 앞부분의 날짜(YYYY.MM 또는 YYYY) → 정렬 키(큰 값이 최신). 날짜가 없으면 null. 기간이면 끝(없으면 시작) 기준. */
export function extraDateKey(text: string): number | null {
  const dates = [...text.matchAll(/((?:19|20)\d{2})(?:[.\-/]\s?(\d{1,2}))?/g)].map((m) => Number(m[1]) * 100 + (m[2] ? Math.min(12, Number(m[2])) : 0));
  if (dates.length === 0) return null;
  if (/현재|재학|진행\s*중/.test(text)) return 999_999;
  return Math.max(...dates.slice(0, 2));
}

/** 최신순(날짜 없는 줄은 원래 순서로 뒤에). 안정 정렬. */
export function sortNewestFirst(items: readonly string[]): string[] {
  return items
    .map((text, i) => ({ text, i, key: extraDateKey(text) }))
    .sort((a, b) => {
      if (a.key === null && b.key === null) return a.i - b.i;
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return b.key - a.key || a.i - b.i;
    })
    .map((x) => x.text);
}

export interface NormalizeExtrasOptions {
  /** 신입(경력 항목 없음)이면 신입 순서. */
  newcomer: boolean;
  /** 사소한 일화 줄을 뺄지(기본 true). */
  dropTrivial?: boolean;
}

export interface NormalizeExtrasResult {
  extras: ResumeExtras;
  /** 뺀 줄(사소한 일화·소감 등). */
  dropped: string[];
}

/**
 * 묶음 규칙을 결정적으로 적용한다(순수, 입력을 바꾸지 않는다): 빈 줄·빈 묶음 제거, 사소한 일화 제거,
 * 전체 2개 이하면 '수상·기타' 한 묶음, 묶음 안 최신순, 묶음은 경력자/신입 순서(모르는 묶음은 뒤에, 원래 순서).
 */
export function normalizeExtras(extras: ResumeExtras, opts: NormalizeExtrasOptions): NormalizeExtrasResult {
  const dropTrivial = opts.dropTrivial ?? true;
  const dropped: string[] = [];
  const groups = extras
    .map((g) => {
      const items = g.items
        .map((x) => x.trim())
        .filter((x) => {
          if (!x) return false;
          if (dropTrivial && isTrivialExtra(x)) {
            dropped.push(x);
            return false;
          }
          return true;
        });
      return { title: g.title.trim(), items };
    })
    .filter((g) => g.items.length > 0);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (total === 0) return { extras: [], dropped };
  if (total <= 2) {
    const items = groups.flatMap((g) => g.items);
    return { extras: [{ title: EXTRAS_MERGED_TITLE, items: sortNewestFirst(items) }], dropped };
  }
  const order = opts.newcomer ? EXTRAS_ORDER_NEWCOMER : EXTRAS_ORDER_EXPERIENCED;
  const rank = (g: { title: string; items: string[] }) => {
    const c = classifyExtra(g.title, g.items);
    return c === null ? order.length : order.indexOf(c);
  };
  const sorted = groups
    .map((g, i) => ({ g, i, r: rank(g) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ g }) => ({ title: g.title.slice(0, 80) || EXTRAS_MERGED_TITLE, items: sortNewestFirst(g.items).slice(0, MAX_ITEMS) }));
  return { extras: sorted.slice(0, MAX_GROUPS), dropped };
}

/** 문서가 신입(경력 항목이 비었음)인지. */
export function isNewcomerDocument(doc: Pick<ResumeDocument, "experience">): boolean {
  return !doc.experience.some((e) => e.company.trim() || e.title.trim());
}

/**
 * 흔히 쓰는 기타 정보(수상·어학, 신입이면 교육 이수·병역)가 문서에 없을 때 사용자에게 물을 질문(최대 1개 — 지어내지 않는다).
 * 자격·어학 섹션(certifications)에 어학 시험이 있으면 어학은 있는 것으로 본다.
 */
export function extrasMissingQuestions(doc: Pick<ResumeDocument, "experience" | "extras" | "certifications">): string[] {
  const texts = [
    ...doc.extras.flatMap((g) => [g.title, ...g.items]),
    ...doc.certifications.map((c) => `${c.name} ${c.issuer}`),
  ].filter((t) => t.trim());
  const has = (id: ExtrasCategoryId) => texts.some((t) => EXTRAS_CATEGORIES[id].match.test(t));
  const wanted: ExtrasCategoryId[] = isNewcomerDocument(doc) ? ["award", "language", "training", "military"] : ["award", "language"];
  const missing = wanted.filter((id) => !has(id)).map((id) => EXTRAS_CATEGORIES[id].title);
  if (missing.length === 0) return [];
  return [`${missing.join("·")} 정보가 자료에 없어 '수상·기타'에 넣지 않았습니다. 해당하는 것이 있으면 날짜·기관과 함께 알려 주세요(없으면 그대로 두세요).`];
}

/**
 * normalizeExtras 전후의 경로 대응: before의 `extras[i].items[j]`·`extras[i]`·`extras[i].title` → after의 같은 줄(글로 찾는다).
 * 뺀 줄이면 null. extras가 아닌 경로는 그대로 돌려준다. 인용·리포트 경로를 정리 뒤 문서에 맞출 때 쓴다(순수).
 */
export function extrasPathMapper(before: ResumeExtras, after: ResumeExtras): (path: string) => string | null {
  const slots = new Map<string, string[]>();
  after.forEach((g, i) => g.items.forEach((x, j) => slots.set(x.trim(), [...(slots.get(x.trim()) ?? []), `${i}:${j}`])));
  const itemMap = new Map<string, { i: number; j: number }>();
  before.forEach((g, i) =>
    g.items.forEach((x, j) => {
      const free = slots.get(x.trim());
      const hit = free?.shift();
      if (!hit) return;
      const [ni, nj] = hit.split(":").map(Number);
      itemMap.set(`${i}:${j}`, { i: ni!, j: nj! });
    }),
  );
  const groupOf = (i: number): number | null => {
    for (let j = 0; j < (before[i]?.items.length ?? 0); j++) {
      const m = itemMap.get(`${i}:${j}`);
      if (m) return m.i;
    }
    return null;
  };
  return (path) => {
    const m = /^extras\[(\d+)\](?:\.(title)|\.items\[(\d+)\])?$/.exec(path);
    if (!m) return path.startsWith("extras[") ? null : path;
    const i = Number(m[1]);
    if (m[3] !== undefined) {
      const hit = itemMap.get(`${i}:${Number(m[3])}`);
      return hit ? `extras[${hit.i}].items[${hit.j}]` : null;
    }
    const g = groupOf(i);
    if (g === null) return null;
    return m[2] ? `extras[${g}].title` : `extras[${g}]`;
  };
}
