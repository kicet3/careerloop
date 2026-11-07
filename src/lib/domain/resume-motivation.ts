/**
 * 지원 동기 '쓸 거리 추천'(task 'resume-motivation-suggest') 계약 — 클라이언트·서버 공용(순수).
 * AI는 [ADD: …] 자리표시가 든 초안을 기본 제공하고(에이전트로 만든 지원처별 이력서는 지원 동기 칸에 검증된 초안이 들어간다),
 * 사용자가 자리표시를 채우고 내 말로 다듬는다. '추천 받기'는 재료(공고가 강조하는 점·이어지는 경험·문단 구성·물어볼 질문·주의점 — 문장 금지)와,
 * 그 재료를 종합한 짧은 초안(draft — 제안일 뿐, 사용자가 '초안으로 채우기'를 눌러야 칸에 들어간다)을 추천한다.
 * 에이전트가 미리 계산한 추천과 버튼으로 받은 추천은 이력서당 마지막 하나를 저장한다(GET이 돌려준다).
 * 서버(src/lib/resumes/motivation.ts)가 공고 인용·그래프 노드 id·숫자·문장형 여부를, 초안은 근거 없는 숫자·지어낸 동기 표현을 결정적으로 다시 거른다.
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

/** 서버가 거른 초안 상한(3~5문장). LLM 출력은 여유를 두고 받아 서버가 문장 단위로 줄인다. */
export const MOTIVATION_DRAFT_MAX = 800;

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
  // 예전 출력(초안 없음)도 받는다.
  draft: z
    .string()
    .max(2000)
    .default("")
    .describe("위 재료를 종합한 지원 동기 초안 3~5문장(700자 안). 자료에 없는 동기·계기·느낌은 [ADD: …] 자리표시로"),
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

/** 저장·응답용 추천(서버 거르기 통과본 — 이어지는 경험은 그래프에서 확인한 노드). */
export const StoredMotivationSuggestionSchema = MotivationSuggestionSchema.omit({ linkedExperiences: true }).extend({
  linkedExperiences: z.array(z.object({ nodeId: z.string().max(80), name: z.string().max(120), kind: z.string().max(40), why: z.string().max(MOTIVATION_HINT_MAX) })).max(3),
});

/** GET /api/resumes/[id]/motivation/suggest: 저장된 마지막 추천(없으면 null). jdChanged: 추천을 만든 뒤 이력서 JD가 바뀌었다. */
export interface SavedMotivationSuggestResponse {
  saved: { suggestion: MotivationSuggestResponse["suggestion"]; source: "agent" | "button"; createdAt: number; jdChanged: boolean } | null;
}
