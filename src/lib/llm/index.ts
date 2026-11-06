import { RETIRED_ENGINE_MESSAGE, type ProviderId } from "@/lib/domain/providers";
import { AnthropicLlmClient, anthropicModelName } from "./anthropic";
import { ClaudeCliLlmClient, claudeCliModel, CodexCliLlmClient, codexCliModel } from "./cli";
import { LlmPermanentError, type GenerateResult, type LlmClient } from "./types";
import { UsageRecordingLlmClient, type LlmUsageContext } from "./usage";

export type { LlmClient, LlmUsage, GenerateRequest, TaskRequest, LlmRequest, LlmTask, GenerateResult, Effort } from "./types";
export { LlmPermanentError, LLM_TASKS, requestLabel } from "./types";
export type { LlmUsageContext } from "./usage";

/** 엔진을 고르지 않은 요청의 기본 엔진. 실제 사용 가능 여부는 providers/options.ts가 검증한다. */
export function defaultProvider(): ProviderId {
  return "anthropic";
}

/** 예전(엔진 컬럼이 없던) 진단 행의 엔진 추정. 없앤 샘플 엔진 행은 domain/providers.ts isRetiredEngine으로 따로 막는다. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 호출부 호환용 인자(예전엔 model로 mock을 골랐다)
export function legacyProvider(_model: string): ProviderId {
  return "anthropic";
}

/** 호출하면 바로 영구 오류를 내는 클라이언트(키가 없거나 지원하지 않는 엔진). 단계 실패로 기록된다. */
class UnavailableLlmClient implements LlmClient {
  readonly name = "unavailable";
  constructor(private readonly message: string) {}
  async generate<T>(): Promise<GenerateResult<T>> {
    throw new LlmPermanentError(this.message, "unavailable");
  }
}

/**
 * 엔진별 LLM 클라이언트. 실제 호출하는 클라이언트는 사용량 기록(llm_usage_events)으로 감싼다 —
 * usage.userId가 그 호출을 매길 사용자다(사용자에 묶이지 않은 호출이면 null).
 */
export function createLlmClient(provider: ProviderId, usage: LlmUsageContext): LlmClient {
  const inner = createRawLlmClient(provider);
  if (inner instanceof UnavailableLlmClient) return inner;
  return new UsageRecordingLlmClient(inner, { provider, model: modelNameFor(provider), ctx: usage });
}

function createRawLlmClient(provider: ProviderId): LlmClient {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY
        ? new AnthropicLlmClient()
        : new UnavailableLlmClient("서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다");
    case "claude-cli":
      return new ClaudeCliLlmClient();
    case "codex-cli":
      return new CodexCliLlmClient();
    default:
      // DB에 남은 예전 엔진 값(예: 없앤 'mock')이 타입을 우회해 들어온 경우.
      return new UnavailableLlmClient(RETIRED_ENGINE_MESSAGE);
  }
}

/** 진단 행의 model 컬럼에 기록할 이름. */
export function modelNameFor(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return anthropicModelName();
    case "claude-cli":
      return `${claudeCliModel()} (Claude 계정 로그인)`;
    case "codex-cli":
      return `${codexCliModel() ?? "Codex 기본 모델"} (ChatGPT 계정 로그인)`;
  }
}

/** 기본 엔진의 모델 이름(예전 호출부 호환). */
export function currentModelName(): string {
  return modelNameFor(defaultProvider());
}
