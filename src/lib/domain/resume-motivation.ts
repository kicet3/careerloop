/**
 * 지원 동기 '쓸 거리 추천'(task 'resume-motivation-suggest') 계약 — 클라이언트·서버 공용(순수).
 * 지원 동기는 사용자가 직접 쓴다. AI는 문단을 쓰지 않고 재료(공고가 강조하는 점·이어지는 경험·문단 구성·물어볼 질문·주의점)만 추천한다.
 * 서버(src/lib/resumes/motivation.ts)가 공고 인용·그래프 노드 id·숫자·문장형 여부를 결정적으로 다시 거른다.
 */
import { z } from "zod";
import { MAX_RESUME_MOTIVATION_CHARS } from "./resumes";

/** 추천 요청 본문: 편집 중인 지원 동기(저장 전일 수 있다). */
export const MotivationSuggestInputSchema = z.object({
  motivation: z.string().max(MAX_RESUME_MOTIVATION_CHARS, `지원 동기는 ${MAX_RESUME_MOTIVATION_CHARS}자까지 쓸 수 있습니다.`).default(""),
});
export type MotivationSuggestInput = z.infer<typeof MotivationSuggestInputSchema>;

/** 프롬프트에서 사용자가 지금까지 쓴 지원 동기를 감싸는 태그(src/lib/resumes/motivation.ts가 태그 탈출을 막는다). */
export const MOTIVATION_DRAFT_TAG = "motivation_draft";

/** 항목 한 줄 상한(문단을 쓰지 못하게 짧게 둔다). */
export const MOTIVATION_HINT_MAX = 160;

const hint = (d: string) => z.string().max(MOTIVATION_HINT_MAX).describe(d);

/** LLM 출력(그리고 서버가 거른 뒤 API 응답) 형식. */
export const MotivationSuggestionSchema = z.object({
  companyPoints: z
    .array(
      z.object({
        point: hint("공고·회사가 강조하는 점 한 구절(명사형, 문장 금지)"),
        jdQuote: z.string().max(200).describe("그 근거가 되는 공고 원문 구절(그대로 복사). 없으면 빈 문자열"),
      }),
    )
    .max(5),
  linkedExperiences: z
    .array(
      z.object({
        nodeId: z.string().max(80).describe("경험 그래프 노드 id(대괄호 안의 값 그대로)"),
        name: z.string().max(120).describe("노드 이름"),
        why: hint("이 경험이 회사·직무와 어떻게 이어지는지 한 구절(근거에 있는 사실만)"),
      }),
    )
    .max(3),
  outline: z
    .array(
      z.object({
        heading: z.string().max(40).describe("문단 역할(예: 지원 계기, 이어지는 경험, 입사 후 기여)"),
        guide: hint("그 문단에 무엇을 쓰면 좋을지 안내(완성 문장 금지 — '~을 적어 보세요' 같은 안내)"),
      }),
    )
    .max(5),
  questions: z.array(hint("지원자에게 물어볼 질문(예: 회사를 처음 알게 된 계기는?)")).max(6),
  cautions: z.array(hint("쓸 때 주의할 점")).max(5),
});
export type MotivationSuggestion = z.infer<typeof MotivationSuggestionSchema>;

/** API 응답의 이어지는 경험: 서버가 그래프에서 확인한 노드(이름·종류는 그래프 값). */
export interface MotivationLinkedExperience {
  nodeId: string;
  name: string;
  /** 노드 종류 표시(예: 프로젝트). */
  kind: string;
  why: string;
}

export interface MotivationSuggestResponse {
  suggestion: Omit<MotivationSuggestion, "linkedExperiences"> & { linkedExperiences: MotivationLinkedExperience[] };
}
