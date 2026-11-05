import type { ProviderId } from "@/lib/domain/providers";
import { AnthropicLlmClient, anthropicModelName } from "./anthropic";
import { ClaudeCliLlmClient, claudeCliModel, CodexCliLlmClient, codexCliModel } from "./cli";
import { MOCK_MODEL_NAME, MockLlmClient } from "./mock";
import type { LlmClient } from "./types";

export type { LlmClient, LlmUsage, GenerateRequest, GenerateResult, Effort } from "./types";
export { LlmPermanentError } from "./types";

function isMockMode(): boolean {
  return process.env.LLM_MOCK === "1" || !process.env.ANTHROPIC_API_KEY;
}

/** 엔진을 고르지 않은 요청의 기본 엔진: API 키가 있으면 Claude API, 없거나 LLM_MOCK=1이면 mock. */
export function defaultProvider(): ProviderId {
  return isMockMode() ? "mock" : "anthropic";
}

/** 예전(엔진 컬럼이 없던) 진단 행의 엔진 추정. */
export function legacyProvider(model: string): ProviderId {
  return model === MOCK_MODEL_NAME ? "mock" : "anthropic";
}

/** LLM_MOCK=1이면 어떤 엔진이든 mock(테스트·데모). */
export function createLlmClient(provider: ProviderId = defaultProvider()): LlmClient {
  if (process.env.LLM_MOCK === "1") return new MockLlmClient();
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ? new AnthropicLlmClient() : new MockLlmClient();
    case "claude-cli":
      return new ClaudeCliLlmClient();
    case "codex-cli":
      return new CodexCliLlmClient();
    case "mock":
      return new MockLlmClient();
  }
}

/** 진단 행의 model 컬럼에 기록할 이름. */
export function modelNameFor(provider: ProviderId): string {
  if (process.env.LLM_MOCK === "1") return MOCK_MODEL_NAME;
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY ? anthropicModelName() : MOCK_MODEL_NAME;
    case "claude-cli":
      return `${claudeCliModel()} (Claude 계정 로그인)`;
    case "codex-cli":
      return `${codexCliModel() ?? "Codex 기본 모델"} (ChatGPT 계정 로그인)`;
    case "mock":
      return MOCK_MODEL_NAME;
  }
}

/** 기본 엔진의 모델 이름(예전 호출부 호환). */
export function currentModelName(): string {
  return modelNameFor(defaultProvider());
}
