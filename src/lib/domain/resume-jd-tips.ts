/**
 * JD 맞춤 작성 팁(task 'resume-jd-tips') 계약 — 클라이언트·서버 공용(순수).
 * 지원처별 이력서의 JD(이력서 jd_text, 비어 있으면 연결 공고 jd_text)로 LLM이 한 번 만들고, (사용자, JD 해시)로 저장해 다시 쓴다.
 * 서버(src/lib/resumes/jd-tips.ts)가 공고 인용·키워드(공고에 있는 말만)·그래프 노드(본인 것만)·근거 없는 숫자를 결정적으로 다시 거른다.
 * 키워드 포함 여부는 LLM이 아니라 resumeKeywordCoverage(결정적 문자열 비교)로 계산한다 — 편집 화면은 같은 함수로 지금 문서를 다시 센다.
 */
import { z } from "zod";
import type { ResumeDocument } from "./resumes";

/** 팁을 나누는 이력서 구역(화면 순서). */
export const JD_TIP_SECTIONS = [
  { id: "first", label: "첫 화면 · 한 줄 소개·요약" },
  { id: "highlights", label: "핵심 성과" },
  { id: "experience", label: "경력" },
  { id: "projects", label: "프로젝트" },
  { id: "skills", label: "직무 역량" },
  { id: "extras", label: "기타(학력·자격·활동)" },
  { id: "motivation", label: "지원 동기" },
] as const;
export type JdTipSectionId = (typeof JD_TIP_SECTIONS)[number]["id"];
const SECTION_IDS = JD_TIP_SECTIONS.map((s) => s.id) as [JdTipSectionId, ...JdTipSectionId[]];

/** JD 요약 줄 종류. */
export const JD_SUMMARY_KINDS = ["duty", "required", "preferred"] as const;
export type JdSummaryKind = (typeof JD_SUMMARY_KINDS)[number];
export const JD_SUMMARY_KIND_LABELS: Record<JdSummaryKind, string> = { duty: "핵심 업무", required: "필수", preferred: "우대" };

/** 팁 한 줄 상한. */
export const JD_TIP_MAX = 200;
/** 프롬프트에 넣는 JD 상한. */
export const JD_TIPS_JD_MAX = 12_000;

const line = (d: string) => z.string().max(JD_TIP_MAX).describe(d);

/** LLM 출력 형식(서버가 거른 뒤 저장·응답도 같은 형식 — 노드 id만 이름으로 바뀐다). */
export const JdTipsOutputSchema = z.object({
  summary: z
    .array(z.object({ kind: z.enum(JD_SUMMARY_KINDS), text: line("공고 요약 한 줄(명사형 구절). 공고에 있는 말만") }))
    .max(8)
    .describe("공고 요약 3~6줄: 핵심 업무(duty)·필수 요건(required)·우대 사항(preferred)"),
  sections: z
    .array(
      z.object({
        section: z.enum(SECTION_IDS),
        tips: z
          .array(
            z.object({
              tip: line("이 구역에서 바로 할 수 있는 구체적인 작성 팁 한 줄('~하세요' 안내형)"),
              jdQuote: z.string().max(200).describe("이 팁의 근거가 되는 공고 원문 구절(그대로 복사)"),
            }),
          )
          .max(5),
      }),
    )
    .max(7),
  keywords: z.array(z.string().max(40)).max(20).describe("이력서에 넣으면 좋은 공고의 핵심 키워드(공고에 그대로 있는 말만)"),
  experiences: z
    .array(
      z.object({
        nodeId: z.string().max(80).describe("경험 그래프 노드 id(대괄호 안의 값 그대로)"),
        section: z.enum(SECTION_IDS).describe("이 경험을 쓰기 좋은 구역"),
        why: line("어느 공고 요건과 이어지는지 한 구절(근거 줄에 있는 사실만)"),
      }),
    )
    .max(8),
});
export type JdTipsOutput = z.infer<typeof JdTipsOutputSchema>;

/** 서버가 거른 팁(저장·응답). experiences는 그래프에서 확인한 노드 이름만 싣는다. */
export interface JdTips {
  summary: { kind: JdSummaryKind; text: string }[];
  sections: { section: JdTipSectionId; tips: { tip: string; jdQuote: string }[] }[];
  keywords: string[];
  experiences: { name: string; kind: string; section: JdTipSectionId; why: string }[];
  /** 만들 때 생긴 안내(그래프를 못 불러옴 등). */
  notices: string[];
}

export const StoredJdTipsSchema = z.object({
  summary: z.array(z.object({ kind: z.enum(JD_SUMMARY_KINDS), text: z.string().max(JD_TIP_MAX) })).max(8),
  sections: z.array(z.object({ section: z.enum(SECTION_IDS), tips: z.array(z.object({ tip: z.string().max(JD_TIP_MAX), jdQuote: z.string().max(200) })).max(5) })).max(7),
  keywords: z.array(z.string().max(40)).max(20),
  experiences: z.array(z.object({ name: z.string().max(120), kind: z.string().max(40), section: z.enum(SECTION_IDS), why: z.string().max(JD_TIP_MAX) })).max(8),
  notices: z.array(z.string().max(300)).max(5).default([]),
});

export interface KeywordCoverage {
  keyword: string;
  included: boolean;
}

/**
 * GET·POST /api/resumes/[id]/tips 응답.
 * - no_jd: 공용 이력서이거나 JD가 비어 있다(화면은 기본 작성 팁만).
 * - none: 이 JD로 만든 팁이 아직 없다.
 * - ready: 지금 JD로 만든 팁(reused: 같은 JD의 다른 내 이력서에서 만든 것을 다시 씀).
 * - stale: 이 이력서에서 예전 JD로 만든 팁 — JD가 바뀌었다('다시 만들기' 권장).
 */
export type ResumeJdTipsResponse =
  | { status: "no_jd"; reason: "general" | "empty" }
  | { status: "none" }
  | { status: "ready" | "stale"; tips: JdTips; coverage: KeywordCoverage[]; createdAt: number; reused: boolean };

export const GenerateJdTipsInputSchema = z.object({ force: z.boolean().optional().default(false) });

// ---------------------------------------------------------------------------
// 키워드 포함 여부(결정적)
// ---------------------------------------------------------------------------

/** 비교에서 무시하는 구분 기호(공백 포함). */
const KW_SEP = "\\s\\-_./·•,()'\"‘’“”";
const KW_SEP_RE = new RegExp(`[${KW_SEP}]+`, "g");

/** 비교용 정규화: NFKC·소문자, 공백과 흔한 구분 기호(- _ . / · • , ( ) ' ")를 지운다. 'Node.js' = 'nodejs', '백엔드 개발' = '백엔드개발'. */
export function normalizeKeyword(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(KW_SEP_RE, "");
}

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ASCII_ALNUM = /[a-z0-9]/;

/**
 * 키워드 비교 정규식(NFKC·소문자로 바꾼 텍스트에 쓴다). 글자 사이에 구분 기호가 있어도 된다('node js' = 'Node.js' = 'nodejs').
 * 영문·숫자로 시작·끝나는 키워드는 앞뒤에 영문·숫자가 붙으면 다른 낱말로 본다 — 'Java'는 'JavaScript'에, 'Go'는 'Google'에, 'AI'는 'email'에 걸리지 않는다.
 * 한글은 조사가 붙으므로('백엔드를') 경계를 보지 않는다.
 */
function keywordPattern(keyword: string): RegExp | null {
  const chars = [...normalizeKeyword(keyword)];
  if (chars.length === 0) return null;
  const body = chars.map(escapeRe).join(`[${KW_SEP}]*`);
  const head = ASCII_ALNUM.test(chars[0]) ? "(?<![a-z0-9])" : "";
  const tail = ASCII_ALNUM.test(chars[chars.length - 1]) ? "(?![a-z0-9])" : "";
  return new RegExp(head + body + tail, "u");
}

const prepare = (text: string) => text.normalize("NFKC").toLowerCase();

/** 이력서 문서의 모든 글자(키워드 비교용). [ADD: …] 자리표시는 뺀다. */
export function resumeDocumentText(doc: ResumeDocument): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return out.join("\n").replace(/\[ADD:[^\]]*\]/g, " ");
}

/** 키워드가 텍스트에 있는지(keywordPattern). 빈 키워드는 false. */
export function containsKeyword(text: string, keyword: string): boolean {
  const re = keywordPattern(keyword);
  return !!re && re.test(prepare(text));
}

/** 키워드마다 지금 이력서에 들어 있는지. */
export function resumeKeywordCoverage(doc: ResumeDocument, keywords: readonly string[]): KeywordCoverage[] {
  const hay = prepare(resumeDocumentText(doc));
  return keywords.map((keyword) => {
    const re = keywordPattern(keyword);
    return { keyword, included: !!re && re.test(hay) };
  });
}
