/**
 * 구조화 공고(클라이언트·서버 공용, 순수): 공고 본문을 구역(회사 소개·포지션 개요·주요 업무·자격 요건·우대 사항·기술 스택·
 * 근무 조건·복지·채용 절차·제출 서류/지원 방법·기타)으로 나눈 데이터. job_postings.structured(jsonb)에 저장한다.
 * - PostingStructureSchema: 저장·화면용. 읽을 때 safeParse로 검증하고, 버전이 다르거나 깨졌으면 null로 본다.
 * - PostingSectionsLlmSchema: LLM 출력(task 'posting-extract'). 구조화 출력 규약대로 선택 필드·유니온 없이 모두 필수.
 *   개수·길이 상한은 구조화 출력이 강제하지 않으므로(description에만 적힌다) groundStructure(src/lib/postings/structure.ts)가 자른다.
 * - PostingStructureEditSchema: 사용자가 '구역 편집'으로 보내는 값(PATCH { structured }).
 * 고용형태·근무형태·경력·근무지·마감은 기존 job_postings 컬럼을 쓴다(여기에 중복하지 않는다).
 */
import { z } from "zod";

export const POSTING_STRUCTURE_VERSION = 1;

export const STRUCTURE_LIMITS = {
  /** 리스트 항목 하나. */
  item: 300,
  /** 짧은 값(업종·규모·연봉·근무시간). */
  short: 120,
  summary: 300,
  /** 주요 업무·자격·우대·복지. */
  list: 25,
  /** 채용 절차·제출 서류·근무 조건 기타. */
  small: 10,
  companyIntro: 6,
  applyMethod: 6,
  notes: 15,
  tech: 30,
  techItem: 60,
} as const;

export const STRUCTURE_SOURCES = ["llm", "regex", "user"] as const;
export type StructureSource = (typeof STRUCTURE_SOURCES)[number];
export const STRUCTURE_SOURCE_LABELS: Record<StructureSource, string> = {
  llm: "AI가 원문에서 옮겨 정리",
  regex: "자동 분류(제목 기준)",
  user: "직접 편집",
};

const item = z.string().trim().min(1).max(STRUCTURE_LIMITS.item);
const short = z.string().trim().max(STRUCTURE_LIMITS.short);
const list = (n: number) => z.array(item).max(n);
const techItem = z.string().trim().min(1).max(STRUCTURE_LIMITS.techItem);

const structureContent = {
  /** 회사 소개. */
  company: z.object({ industry: short, size: short, intro: list(STRUCTURE_LIMITS.companyIntro) }),
  /** 포지션 개요(모델이 쓴 문장을 허용하는 유일한 필드 — 화면에 'AI 요약' 라벨). */
  summary: z.string().trim().max(STRUCTURE_LIMITS.summary),
  duties: list(STRUCTURE_LIMITS.list),
  requirements: list(STRUCTURE_LIMITS.list),
  preferred: list(STRUCTURE_LIMITS.list),
  /** 정식 명칭(canonicalSkill)으로 바꾼 기술 이름. */
  techStack: z.array(techItem).max(STRUCTURE_LIMITS.tech),
  conditions: z.object({ salary: short, workHours: short, other: list(STRUCTURE_LIMITS.small) }),
  benefits: list(STRUCTURE_LIMITS.list),
  /** 채용 절차(단계 순서). */
  process: list(STRUCTURE_LIMITS.small),
  application: z.object({ documents: list(STRUCTURE_LIMITS.small), method: list(STRUCTURE_LIMITS.applyMethod) }),
  notes: list(STRUCTURE_LIMITS.notes),
};

/** 저장·화면용(jsonb). */
export const PostingStructureSchema = z.object({
  version: z.literal(POSTING_STRUCTURE_VERSION),
  source: z.enum(STRUCTURE_SOURCES),
  ...structureContent,
  /** jdText를 이 구조로 다시 만들었는가(구조를 편집하면 jdText도 다시 조합한다). */
  jdComposed: z.boolean(),
  /** 구조를 만든 입력 텍스트의 해시(sourceHash). 원문이 바뀌었는지 판단한다. */
  sourceHash: z.string().max(32),
  extractedAt: z.number().int(),
});
export type PostingStructure = z.infer<typeof PostingStructureSchema>;

/** 사용자가 '구역 편집'으로 보내는 값. 출처·버전·시각·조합 여부는 서버가 정한다. */
export const PostingStructureEditSchema = z.object(structureContent).strict();
export type PostingStructureEdit = z.infer<typeof PostingStructureEditSchema>;

/** 빈 구조 내용. */
export function emptyStructureContent(): PostingStructureEdit {
  return {
    company: { industry: "", size: "", intro: [] },
    summary: "",
    duties: [],
    requirements: [],
    preferred: [],
    techStack: [],
    conditions: { salary: "", workHours: "", other: [] },
    benefits: [],
    process: [],
    application: { documents: [], method: [] },
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// LLM 출력(task 'posting-extract')
// ---------------------------------------------------------------------------

// 개수·길이 상한은 description에만 적는다. zod .max()를 걸면 모델이 한 항목만 길게 옮겨도 검증이 실패해
// 같은 호출의 회사·직무·마감까지 가져오기 전체가 실패한다. 근거 검증 뒤 groundStructure가 상한대로 자른다.
const copied = (max: number, what: string) =>
  z
    .array(z.string())
    .describe(`${what}. 본문 항목을 한 줄에 하나씩 그대로 복사(바꿔 쓰거나 합치지 않는다). 최대 ${max}개(한 항목 ${STRUCTURE_LIMITS.item}자 이내), 없으면 []`);

/** 공고 구역(LLM 출력). 모든 필드 필수, 없으면 ""/[]. */
export const PostingSectionsLlmSchema = z.object({
  companyIndustry: z.string().describe(`업종. 본문 문구 그대로(${STRUCTURE_LIMITS.short}자 이내), 없으면 빈 문자열`),
  companySize: z.string().describe("규모(직원 수·투자 단계). 본문 문구 그대로, 없으면 빈 문자열"),
  companyIntro: copied(STRUCTURE_LIMITS.companyIntro, "회사 소개 문장"),
  summary: z.string().describe(`포지션 개요 1~2문장(${STRUCTURE_LIMITS.summary}자 이내). 본문에 없는 수치·조건 금지`),
  duties: copied(STRUCTURE_LIMITS.list, "주요 업무"),
  requirements: copied(STRUCTURE_LIMITS.list, "자격 요건(필수)"),
  preferred: copied(STRUCTURE_LIMITS.list, "우대 사항"),
  techStack: z
    .array(z.string())
    .describe(`본문에 나온 기술 이름 그대로. 최대 ${STRUCTURE_LIMITS.tech}개`),
  salary: z.string().describe("연봉·급여. 본문 표기 그대로, 없으면 빈 문자열"),
  workHours: z.string().describe("근무 시간. 본문 표기 그대로, 없으면 빈 문자열"),
  conditionsOther: copied(STRUCTURE_LIMITS.small, "그 밖의 근무 조건(수습·근무 요일 등, 복지 제외)"),
  benefits: copied(STRUCTURE_LIMITS.list, "복리후생·혜택"),
  process: copied(STRUCTURE_LIMITS.small, "채용 절차(단계 순서대로)"),
  documents: copied(STRUCTURE_LIMITS.small, "제출 서류"),
  applyMethod: copied(STRUCTURE_LIMITS.applyMethod, "지원·접수 방법"),
  notes: copied(STRUCTURE_LIMITS.notes, "위 구역에 넣지 못한 기타 안내"),
});
export type PostingSectionsLlm = z.infer<typeof PostingSectionsLlmSchema>;

/** 구역만 다시 정리할 때(POST /api/postings/[id]/structure)의 LLM 출력. */
export const PostingSectionsOnlySchema = z.object({ sections: PostingSectionsLlmSchema });
export type PostingSectionsOnly = z.infer<typeof PostingSectionsOnlySchema>;

// ---------------------------------------------------------------------------
// 구역 라벨(화면·jdText 조합 공용)
// ---------------------------------------------------------------------------

export const STRUCTURE_SECTION_LABELS = {
  summary: "포지션 개요",
  duties: "주요 업무",
  requirements: "자격 요건",
  preferred: "우대 사항",
  techStack: "기술 스택",
  conditions: "근무 조건",
  benefits: "복리후생",
  process: "채용 절차",
  application: "제출 서류·지원 방법",
  company: "회사 소개",
  notes: "기타",
} as const;
export type StructureSectionKey = keyof typeof STRUCTURE_SECTION_LABELS;

/** 목록 카드 칩용 요약(JobPostingSummary.highlights). */
export interface PostingHighlights {
  techStack: string[];
  salary: string;
}
