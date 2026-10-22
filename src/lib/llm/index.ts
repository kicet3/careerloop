import { AnthropicLlmClient, anthropicModelName } from "./anthropic";
import { MOCK_MODEL_NAME, MockLlmClient } from "./mock";
import type { LlmClient } from "./types";

export type { LlmClient, LlmUsage, GenerateRequest, GenerateResult, Effort } from "./types";
export { LlmPermanentError } from "./types";

function isMockMode(): boolean {
  return process.env.LLM_MOCK === "1" || !process.env.ANTHROPIC_API_KEY;
}

/** ANTHROPIC_API_KEY가 없거나 LLM_MOCK=1이면 mock 클라이언트. */
export function createLlmClient(): LlmClient {
  return isMockMode() ? new MockLlmClient() : new AnthropicLlmClient();
}

/** 진단 행의 model 컬럼에 기록할 이름. */
export function currentModelName(): string {
  return isMockMode() ? MOCK_MODEL_NAME : anthropicModelName();
}
