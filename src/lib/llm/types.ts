/**
 * 파이프라인이 의존하는 LLM 경계. 구현체는 anthropic.ts(실제 API)와 mock.ts(키 없이 로컬 개발·테스트)다.
 * 파이프라인은 이 인터페이스만 알기 때문에 테스트에서 가짜 클라이언트를 주입할 수 있다.
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

export interface GenerateRequest<T> {
  stage: StageKey;
  /** 단계 공통 지시문(페르소나·규칙). 캐시가 잘 되도록 요청마다 바뀌는 값을 넣지 않는다. */
  system: string;
  /** 이 요청에서만 쓰는 자료(이력서·JD·이전 단계 결과). */
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateResult<T> {
  output: T;
  usage: LlmUsage;
  /** 실제로 응답한 모델(서버 측 fallback이 동작했으면 대체 모델 이름). */
  model: string;
}

export interface LlmClient {
  readonly name: string;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/** 재시도해도 소용없는 실패(거절, 스키마 불일치 반복 등). */
export class LlmPermanentError extends Error {
  constructor(message: string, readonly reason: "refusal" | "invalid_output" | "max_tokens" | "bad_request") {
    super(message);
    this.name = "LlmPermanentError";
  }
}
