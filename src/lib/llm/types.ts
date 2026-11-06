/**
 * 파이프라인이 의존하는 LLM 경계. 구현체는 anthropic.ts(Claude API)와 cli.ts(Claude·ChatGPT 계정 로그인 CLI)다.
 * 파이프라인은 이 인터페이스만 알기 때문에 테스트에서 가짜 클라이언트(src/test/fake-llm.ts)를 주입할 수 있다.
 */
import type { z } from "zod";
import type { StageKey } from "@/lib/domain/schemas";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 파이프라인 밖 기능의 LLM 호출 종류(심사 단계가 아닌 호출). 테스트용 가짜 LLM은 이 값으로 가짜 출력을 고른다.
 * - graph-chat: 경험 그래프 채팅(GraphChatOutputSchema)
 * - reviewer-chat: 심사위원 채팅(ReviewerChatOutputSchema)
 * - resume-draft: 회사별 이력서 초안(ResumeDraftOutputSchema)
 * - posting-extract: 채용 공고 페이지 본문에서 회사·직무·마감·구역별 항목 추출(PostingExtractSchema, 구역만이면 PostingSectionsOnlySchema)
 * - graph-import: 이력서·포트폴리오 문서 → 그래프 변경안(GraphImportOutputSchema)
 * - graph-qa: 그래프에 묻기 답변(GraphQaOutputSchema)
 * - graph-qa-rerank: 그래프에 묻기 후보 관련도 매기기(GraphQaRerankSchema, 선택 단계)
 * - interview-questions: 이력서·포트폴리오·공고 근거 줄 → 면접 예상 질문(InterviewQuestionsOutputSchema)
 * - interview-feedback: 연습 답변 피드백·모범 답변 개요·꼬리 질문(InterviewFeedbackOutputSchema)
 */
export const LLM_TASKS = [
  "graph-chat",
  "reviewer-chat",
  "resume-draft",
  "posting-extract",
  "graph-import",
  "graph-qa",
  "graph-qa-rerank",
  "interview-questions",
  "interview-feedback",
] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

interface BaseRequest<T> {
  /** 공통 지시문(페르소나·규칙). 캐시가 잘 되도록 요청마다 바뀌는 값을 넣지 않는다. */
  system: string;
  /** 이 요청에서만 쓰는 자료(이력서·JD·이전 단계 결과·대화). */
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * user 앞부분(STAGE_TASK_DELIMITER 앞, 없으면 전체)에 프롬프트 캐시 지점을 둘지(기본 true, Claude API만 해당).
   * 한 번만 보내고 다시 쓰지 않는 호출(공고 추출 등)은 false로 둬 캐시 쓰기 할증을 피한다.
   */
  cacheUser?: boolean;
}

/** 심사 파이프라인 단계 호출. */
export interface GenerateRequest<T> extends BaseRequest<T> {
  stage: StageKey;
  task?: undefined;
}

/** 파이프라인 밖 기능 호출(채팅·이력서 초안 등). */
export interface TaskRequest<T> extends BaseRequest<T> {
  task: LlmTask;
  stage?: undefined;
}

export type LlmRequest<T> = GenerateRequest<T> | TaskRequest<T>;

/** 로그·오류 메시지용 호출 이름(단계 키 또는 task). */
export function requestLabel(req: LlmRequest<unknown>): string {
  return req.task !== undefined ? req.task : req.stage;
}

export interface GenerateResult<T> {
  output: T;
  usage: LlmUsage;
  /** 실제로 응답한 모델(서버 측 fallback이 동작했으면 대체 모델 이름). */
  model: string;
  /** 모델별 사용량(서버 측 fallback으로 여러 모델이 나눠 쓴 경우 비용을 모델별로 매기기 위함). 없으면 usage 전체를 model로 본다. */
  usageByModel?: ModelUsage[];
}

/** 한 모델이 쓴 토큰. */
export interface ModelUsage {
  model: string;
  usage: LlmUsage;
}

export interface LlmClient {
  readonly name: string;
  generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>>;
}

/**
 * 재시도해도 소용없는 실패(거절, 스키마 불일치 반복 등).
 * - max_tokens: 출력 한도(서버 설정)에서 끊김 — 한도를 올려 한 번 더 시도한 뒤에도 끊긴 경우.
 * - context_window: 입력이 모델 컨텍스트를 넘음 — 입력을 줄여야 한다.
 * - auth: CLI 엔진의 계정 로그인이 없거나 만료됨 — 'AI 연결'에서 다시 로그인해야 한다.
 * - usage_limit: 구독 계정의 사용량 한도에 걸림 — 한도가 풀린 뒤 재시도.
 * - unavailable: CLI가 설치되어 있지 않거나 엔진이 꺼져 있음.
 * - timeout: CLI 호출이 제한 시간 안에 끝나지 않음.
 */
export class LlmPermanentError extends Error {
  /** 실패하기 전까지 이미 쓴 토큰. 실패한 단계의 비용도 진단 사용량에 더한다. */
  usage?: LlmUsage;
  constructor(
    message: string,
    readonly reason:
      | "refusal"
      | "invalid_output"
      | "max_tokens"
      | "context_window"
      | "bad_request"
      | "auth"
      | "usage_limit"
      | "unavailable"
      | "timeout",
    usage?: LlmUsage,
  ) {
    super(message);
    this.name = "LlmPermanentError";
    this.usage = usage;
  }
}

/** 실패한 generate()가 그때까지 쓴 토큰(있으면). 클라이언트 구현체가 오류 객체의 usage 필드에 붙인다. */
export function usageOfError(error: unknown): LlmUsage | null {
  const u = (error as { usage?: unknown } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (k: string) => {
    const v = (u as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    inputTokens: n("inputTokens"),
    outputTokens: n("outputTokens"),
    cacheReadTokens: n("cacheReadTokens"),
    cacheWriteTokens: n("cacheWriteTokens"),
  };
}

/** 실패한 generate()의 모델별 사용량(있으면). 클라이언트 구현체가 오류 객체의 usageByModel 필드에 붙인다. */
export function usageByModelOfError(error: unknown): ModelUsage[] | null {
  const v = (error as { usageByModel?: unknown } | null)?.usageByModel;
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: ModelUsage[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || typeof (item as ModelUsage).model !== "string") return null;
    const u = usageOfError(item);
    if (!u) return null;
    out.push({ model: (item as ModelUsage).model, usage: u });
  }
  return out;
}
