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

/**
 * 재시도해도 소용없는 실패(거절, 스키마 불일치 반복 등).
 * - max_tokens: 출력 한도(서버 설정)에서 끊김 — 한도를 올려 한 번 더 시도한 뒤에도 끊긴 경우.
 * - context_window: 입력이 모델 컨텍스트를 넘음 — 입력을 줄여야 한다.
 */
export class LlmPermanentError extends Error {
  /** 실패하기 전까지 이미 쓴 토큰. 실패한 단계의 비용도 진단 사용량에 더한다. */
  usage?: LlmUsage;
  constructor(
    message: string,
    readonly reason: "refusal" | "invalid_output" | "max_tokens" | "context_window" | "bad_request",
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
