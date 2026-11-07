/**
 * 회사(지원처)별 이력서 계약(클라이언트·서버 공용): 양식(템플릿) 정의와 편집 가능한 이력서 문서 구조.
 * 메타데이터는 PostgreSQL(company_resumes·resume_versions), 버전별 본문(ResumeDocument JSON)은 저장소(src/lib/storage).
 *
 * ResumeDocument는 LLM 구조화 출력에도 그대로 쓰므로 선택 필드·유니온 없이 모든 필드를 필수로 둔다(값이 없으면 "" 또는 []).
 * 나중에 더한 필드(성과 중심 양식용: 총 경력·포트폴리오·핵심 성과·부서·담당 범위·문제/행동/결과 등)가 없는
 * 예전 저장본은 upgradeResumeDocument가 빈 값으로 채운 뒤 검증한다(parseResumeDocument).
 */
import { z } from "zod";
import { MAX_PORTFOLIO_TEXT_CHARS, PORTFOLIO_KINDS, type PortfolioInfo, type PortfolioKind } from "./portfolios";

// ---------------------------------------------------------------------------
// 문서 구조
// ---------------------------------------------------------------------------

export const RESUME_SECTION_KEYS = [
  "summary",
  "highlights",
  "experience",
  "projects",
  "skills",
  "education",
  "certifications",
  "extras",
] as const;
export type ResumeSectionKey = (typeof RESUME_SECTION_KEYS)[number];

export const RESUME_SECTION_LABELS: Record<ResumeSectionKey, string> = {
  summary: "요약",
  highlights: "핵심 성과",
  experience: "경력",
  projects: "프로젝트",
  skills: "기술",
  education: "학력",
  certifications: "자격·어학",
  extras: "기타",
};

const s = (max: number) => z.string().max(max);
const bullets = () => z.array(s(500)).max(15);

/** 섹션 제목을 바꿀 수 있는 섹션(성과 중심 양식). 빈 문자열이면 기본 제목. 예: 신입이면 '경력' → '관련 경험'. */
export const RESUME_HEADING_KEYS = ["highlights", "experience", "projects", "skills", "education"] as const;
export type ResumeHeadingKey = (typeof RESUME_HEADING_KEYS)[number];

export const ResumeDocumentSchema = z.object({
  basics: z.object({
    name: s(80),
    headline: s(160).describe("지원 직무만 짧게(예: 백엔드 개발자). 문장형 소개는 tagline에"),
    tagline: s(200).describe("한 줄 소개: 경력 근거로 쓴 한 문장(예: 결제 시스템 지연을 줄여 온 5년 차 백엔드 개발자). 없으면 빈 문자열"),
    totalExperience: s(40).describe('총 경력(예: "5년 3개월"). 자료로 계산할 수 없으면 빈 문자열'),
    email: s(160),
    phone: s(40),
    location: s(80),
    portfolioUrl: s(500).describe("포트폴리오 또는 업무 자료 URL. 자료에 없으면 빈 문자열"),
    links: z.array(z.object({ label: s(40), url: s(500) })).max(6),
  }),
  summary: s(1500).describe("직무 요약. 성과 중심 양식은 줄바꿈으로 나눈 2문장"),
  headings: z
    .object({ highlights: s(30), experience: s(30), projects: s(30), skills: s(30), education: s(30) })
    .describe("섹션 제목 바꾸기. 기본 제목을 쓰면 빈 문자열"),
  highlights: z
    .array(
      z.object({
        title: s(200).describe("핵심 성과 한 줄: 지표 기준값 → 개선값 · 개선 폭"),
        context: s(300).describe("근거: 측정 기간·대상 / 본인이 한 핵심 행동"),
      }),
    )
    .max(8),
  experience: z
    .array(
      z.object({
        company: s(120),
        department: s(120).describe("부서·조직"),
        title: s(120).describe("직무·직급"),
        startDate: s(20).describe("YYYY.MM 형식 권장"),
        endDate: s(20).describe('YYYY.MM, 재직 중이면 "현재"'),
        location: s(80),
        scope: s(600).describe("담당 범위·주요 책임 한 문장"),
        bullets: bullets().describe("대표 기여(직접 결정·실행한 일과 검증된 결과)"),
      }),
    )
    .max(20),
  projects: z
    .array(
      z.object({
        name: s(120),
        company: s(120).describe("프로젝트를 한 회사·활동명"),
        team: s(120).describe("팀 구성(예: 백엔드 3·디자인 1)"),
        role: s(120).describe("내 역할: 결정·실행 범위"),
        startDate: s(20),
        endDate: s(20),
        summary: s(600),
        problem: s(500).describe("문제: 어떤 자료로 어떤 원인·상황을 확인했는지"),
        action: s(500).describe("행동: 본인의 판단·실행·협업"),
        result: s(500).describe("결과: 기간·대상과 지표 전후 변화 또는 검증 결과"),
        evidence: s(300).describe("근거: 측정 자료명 또는 공개 가능한 링크"),
        bullets: bullets(),
        techs: z.array(s(60)).max(20),
      }),
    )
    .max(20),
  skills: z
    .array(
      z.object({
        category: s(60).describe("역량·분류(예: 데이터 분석, 백엔드)"),
        detail: s(300).describe("실제로 할 수 있는 일과 적용 경험 한 줄"),
        items: z.array(s(60)).max(30),
      }),
    )
    .max(10),
  education: z
    .array(
      z.object({
        school: s(120),
        degree: s(60),
        major: s(120),
        startDate: s(20),
        endDate: s(20),
        note: s(300),
      }),
    )
    .max(10),
  certifications: z.array(z.object({ name: s(120), issuer: s(120), date: s(20) })).max(20),
  extras: z.array(z.object({ title: s(80), items: z.array(s(300)).max(15) })).max(8),
});
export type ResumeDocument = z.infer<typeof ResumeDocumentSchema>;
export type ResumeHighlight = ResumeDocument["highlights"][number];
export type ResumeExperience = ResumeDocument["experience"][number];
export type ResumeProject = ResumeDocument["projects"][number];
export type ResumeSkill = ResumeDocument["skills"][number];
export type ResumeEducation = ResumeDocument["education"][number];
export type ResumeCertification = ResumeDocument["certifications"][number];

/** 빈 항목 생성기(편집 폼·성과 양식 편집·빈 문서 뼈대 공용). */
export const EMPTY_RESUME_ITEM = {
  highlight: (): ResumeHighlight => ({ title: "", context: "" }),
  experience: (): ResumeExperience => ({
    company: "",
    department: "",
    title: "",
    startDate: "",
    endDate: "",
    location: "",
    scope: "",
    bullets: [],
  }),
  project: (): ResumeProject => ({
    name: "",
    company: "",
    team: "",
    role: "",
    startDate: "",
    endDate: "",
    summary: "",
    problem: "",
    action: "",
    result: "",
    evidence: "",
    bullets: [],
    techs: [],
  }),
  skill: (): ResumeSkill => ({ category: "", detail: "", items: [] }),
  education: (): ResumeEducation => ({ school: "", degree: "", major: "", startDate: "", endDate: "", note: "" }),
  certification: (): ResumeCertification => ({ name: "", issuer: "", date: "" }),
};

export function emptyResumeDocument(): ResumeDocument {
  return {
    basics: { name: "", headline: "", tagline: "", totalExperience: "", email: "", phone: "", location: "", portfolioUrl: "", links: [] },
    summary: "",
    headings: { highlights: "", experience: "", projects: "", skills: "", education: "" },
    highlights: [],
    experience: [],
    projects: [],
    skills: [],
    education: [],
    certifications: [],
    extras: [],
  };
}

/**
 * 성과 중심 양식의 빈 뼈대: 원본 양식의 예시 구조(성과 2, 경력 2, 프로젝트 2, 역량 2, 학력 1 + 자격 1)를 빈 항목으로 깐다.
 * 빈 칸은 화면에서 원본의 대괄호 안내 문구로 보인다(PDF에는 찍지 않는다).
 */
export function performanceScaffold(doc: ResumeDocument = emptyResumeDocument()): ResumeDocument {
  const fill = <T>(xs: T[], n: number, make: () => T) => (xs.length >= n ? xs : [...xs, ...Array.from({ length: n - xs.length }, make)]);
  // 원본처럼 첫 경력에는 '대표 기여' 불릿 한 줄을 깐다.
  const experience = doc.experience.length > 0 ? doc.experience : [{ ...EMPTY_RESUME_ITEM.experience(), bullets: [""] }];
  return {
    ...doc,
    highlights: fill(doc.highlights, 2, EMPTY_RESUME_ITEM.highlight),
    experience: fill(experience, 2, EMPTY_RESUME_ITEM.experience),
    projects: fill(doc.projects, 2, EMPTY_RESUME_ITEM.project),
    skills: fill(doc.skills, 2, EMPTY_RESUME_ITEM.skill),
    education: fill(doc.education, 1, EMPTY_RESUME_ITEM.education),
    certifications: fill(doc.certifications, 1, EMPTY_RESUME_ITEM.certification),
  };
}

// ---------------------------------------------------------------------------
// 예전 저장본 보정
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === "object" && v !== null && !Array.isArray(v);
/** 객체면 빠진 키만 기본값으로 채운다(있는 값은 그대로 두고 검증은 스키마가 한다). */
const withDefaults = (v: unknown, defaults: Loose): unknown => (isObj(v) ? { ...defaults, ...v } : v);
const eachWithDefaults = (v: unknown, make: () => object): unknown =>
  Array.isArray(v) ? v.map((x) => withDefaults(x, make() as Loose)) : v;

/**
 * 필드가 늘기 전 형식의 문서(JSON)에 새 필드를 빈 값으로 채운다. 순수 함수, 입력을 바꾸지 않는다.
 * 형식이 아예 다르면(객체가 아님 등) 손대지 않고 넘겨 스키마 검증이 실패하게 둔다.
 */
export function upgradeResumeDocument(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const empty = emptyResumeDocument();
  const out: Loose = { ...empty, ...raw };
  // 키가 아예 없으면(undefined·null) 빈 값으로 채운다. 다른 형식이면 그대로 넘겨 스키마가 거절하게 둔다.
  out.basics = withDefaults(raw.basics ?? {}, empty.basics);
  out.headings = withDefaults(raw.headings ?? {}, empty.headings);
  out.highlights = eachWithDefaults(raw.highlights ?? [], EMPTY_RESUME_ITEM.highlight);
  out.experience = eachWithDefaults(raw.experience ?? [], EMPTY_RESUME_ITEM.experience);
  out.projects = eachWithDefaults(raw.projects ?? [], EMPTY_RESUME_ITEM.project);
  out.skills = eachWithDefaults(raw.skills ?? [], EMPTY_RESUME_ITEM.skill);
  out.education = eachWithDefaults(raw.education ?? [], EMPTY_RESUME_ITEM.education);
  out.certifications = eachWithDefaults(raw.certifications ?? [], EMPTY_RESUME_ITEM.certification);
  out.extras = eachWithDefaults(raw.extras ?? [], () => ({ title: "", items: [] }));
  if (out.summary === undefined || out.summary === null) out.summary = "";
  return out;
}

/** 저장본·API 입력 검증: 예전 형식을 보정한 뒤 ResumeDocumentSchema로 검증한다. */
export const StoredResumeDocumentSchema = z.preprocess(upgradeResumeDocument, ResumeDocumentSchema);

export function parseResumeDocument(raw: unknown) {
  return StoredResumeDocumentSchema.safeParse(raw);
}

/**
 * LLM 이력서 초안 출력(task 'resume-draft'). 구조화 출력용 JSON 스키마는 ResumeDocumentSchema(모든 필드 필수) 그대로이고,
 * 검증은 보정을 거친다 — 엔진이 새 필드 몇 개를 빠뜨려도 빈 값으로 받아들인다.
 */
export const ResumeDraftOutputSchema = z.object({
  document: StoredResumeDocumentSchema,
  notes: z.array(z.string()).max(10).describe("초안을 쓰며 내린 판단·가정(한국어)"),
  missingInfo: z.array(z.string()).max(10).describe("채워야 할 정보에 대한 질문. 본문에는 [ADD: ...]로 남긴다"),
});
export type ResumeDraftOutput = z.infer<typeof ResumeDraftOutputSchema>;

/** company: 지원처(공고)별 이력서 · general: 회사 지정 없는 공용(마스터) 이력서(company·roleTitle '', postingId null). */
export const RESUME_KINDS = ["company", "general"] as const;
export type ResumeKind = (typeof RESUME_KINDS)[number];
export const RESUME_KIND_LABELS: Record<ResumeKind, string> = { company: "지원처별 이력서", general: "공용 이력서" };
export const ResumeKindSchema = z.enum(RESUME_KINDS);
/** 공용 이력서의 기본 제목. */
export const GENERAL_RESUME_DEFAULT_TITLE = "공용 이력서";

/**
 * 지원처별 이력서의 지원 상태(company_resumes.apply_status). 공용 이력서는 상태가 없다(null — 화면에는 '공용').
 * '지원 완료'로 바꾸면 연결 공고가 있을 때 공고를 '지원함'으로 두고 지원 기록(제출 사본 고정)을 만들거나 잇는다(src/lib/resumes/apply-status.ts).
 */
export const RESUME_APPLY_STATUSES = ["draft", "applying", "submitted"] as const;
export type ResumeApplyStatus = (typeof RESUME_APPLY_STATUSES)[number];
export const ResumeApplyStatusSchema = z.enum(RESUME_APPLY_STATUSES);
export const RESUME_APPLY_STATUS_LABELS: Record<ResumeApplyStatus, string> = {
  draft: "지원 전",
  applying: "지원 중",
  submitted: "지원 완료",
};
/** 공용 이력서 배지 문구(상태 대신). */
export const GENERAL_RESUME_STATUS_LABEL = "공용";
/** 지원처별 이력서의 기본 상태(예전 행이 null이면 이것으로 본다). */
export const DEFAULT_RESUME_APPLY_STATUS: ResumeApplyStatus = "draft";

/** 행 값 → 화면 상태. 공용 이력서는 늘 null, 지원처별 이력서의 null·모르는 값은 'draft'. */
export function resumeApplyStatusOf(kind: ResumeKind, raw: string | null | undefined): ResumeApplyStatus | null {
  if (kind === "general") return null;
  return (RESUME_APPLY_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as ResumeApplyStatus) : DEFAULT_RESUME_APPLY_STATUS;
}

/** 이력서 첨부 포트폴리오(이력서당 하나): 포트폴리오 보관함(src/lib/domain/portfolios.ts)의 항목을 가리킨다. */
export const RESUME_PORTFOLIO_KINDS = PORTFOLIO_KINDS;
export type ResumePortfolioKind = PortfolioKind;
/** 저장하는 포트폴리오 텍스트 상한(글자). 넘으면 앞부분만 저장하고 truncated로 알린다. */
export const MAX_RESUME_PORTFOLIO_CHARS = MAX_PORTFOLIO_TEXT_CHARS;

/** 이력서에 첨부한 보관함 포트폴리오. */
export type ResumePortfolioInfo = PortfolioInfo;

export const RESUME_VERSION_SOURCES = ["ai", "manual"] as const;
export type ResumeVersionSource = (typeof RESUME_VERSION_SOURCES)[number];

// ---------------------------------------------------------------------------
// 양식
// ---------------------------------------------------------------------------

/** 첫 번째가 기본 양식(새 이력서 기본 선택). */
export const RESUME_TEMPLATE_IDS = ["performance", "classic", "modern", "compact", "developer", "career-change"] as const;
export type ResumeTemplateId = (typeof RESUME_TEMPLATE_IDS)[number];
export const ResumeTemplateIdSchema = z.enum(RESUME_TEMPLATE_IDS);

export interface ResumeTemplateStyle {
  /** 강조색(hex). 웹·PDF 공통. */
  accent: string;
  /** 본문 기준 글자 크기(pt, PDF). */
  baseFontSize: number;
  headingStyle: "underline" | "bar" | "plain";
  /** single: 한 열, sidebar: 옆 열에 기술·학력·자격, labeled: 왼쪽 좁은 열에 섹션 제목을 둔 2단(성과 중심 양식). */
  layout: "single" | "sidebar" | "labeled";
  density: "normal" | "compact";
  /** 기술을 칩(태그)으로 보일지. */
  skillChips: boolean;
}

export interface ResumeTemplate {
  id: ResumeTemplateId;
  name: string;
  description: string;
  sectionOrder: readonly ResumeSectionKey[];
  style: ResumeTemplateStyle;
}

export const RESUME_TEMPLATES: Record<ResumeTemplateId, ResumeTemplate> = {
  performance: {
    id: "performance",
    name: "성과 중심",
    description: "핵심 성과를 맨 위에 두고 경력·프로젝트를 문제→행동→결과로 보여주는 A4 1장 양식. 미리보기에서 바로 고친다.",
    sectionOrder: ["summary", "highlights", "experience", "projects", "skills", "education", "certifications", "extras"],
    style: { accent: "#264e77", baseFontSize: 10, headingStyle: "plain", layout: "labeled", density: "normal", skillChips: false },
  },
  classic: {
    id: "classic",
    name: "클래식",
    description: "대기업·공공기관 서류에 무난한 단일 열 양식. 경력을 시간 역순으로 정리한다.",
    sectionOrder: ["summary", "highlights", "experience", "projects", "skills", "education", "certifications", "extras"],
    style: { accent: "#1e293b", baseFontSize: 10, headingStyle: "underline", layout: "single", density: "normal", skillChips: false },
  },
  modern: {
    id: "modern",
    name: "모던",
    description: "스타트업·외국계에 맞는 깔끔한 양식. 상단 요약과 대표 성과를 강조한다.",
    sectionOrder: ["summary", "highlights", "experience", "skills", "projects", "education", "certifications", "extras"],
    style: { accent: "#4f46e5", baseFontSize: 10, headingStyle: "bar", layout: "single", density: "normal", skillChips: true },
  },
  compact: {
    id: "compact",
    name: "컴팩트",
    description: "한 장에 많이 담는 촘촘한 양식. 경력이 길거나 1쪽 제한이 있을 때.",
    sectionOrder: ["summary", "highlights", "experience", "skills", "education", "projects", "certifications", "extras"],
    style: { accent: "#0f766e", baseFontSize: 9, headingStyle: "plain", layout: "single", density: "compact", skillChips: false },
  },
  developer: {
    id: "developer",
    name: "개발자",
    description: "기술 스택과 프로젝트를 앞세우는 양식. 사이드바에 기술·링크를 둔다.",
    sectionOrder: ["summary", "highlights", "skills", "experience", "projects", "education", "certifications", "extras"],
    style: { accent: "#0369a1", baseFontSize: 9.5, headingStyle: "bar", layout: "sidebar", density: "normal", skillChips: true },
  },
  "career-change": {
    id: "career-change",
    name: "직무 전환",
    description: "옮겨 갈 직무와 이어지는 역량·프로젝트를 경력보다 먼저 보여주는 양식.",
    sectionOrder: ["summary", "highlights", "skills", "projects", "experience", "education", "certifications", "extras"],
    style: { accent: "#b45309", baseFontSize: 10, headingStyle: "underline", layout: "single", density: "normal", skillChips: true },
  },
};

export const DEFAULT_RESUME_TEMPLATE: ResumeTemplateId = "performance";
