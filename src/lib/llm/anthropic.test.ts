import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addUsage, AnthropicLlmClient } from "./anthropic";
import { LlmPermanentError, usageOfError } from "./types";

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const Schema = z.object({ ok: z.boolean() });

type Fake = { stop_reason: string; text: string; usage?: Record<string, unknown> };

/** beta.messages.stream(...).finalMessage()만 흉내 내는 가짜 SDK 클라이언트. 호출 인자를 기록한다. */
function fakeClient(responses: Fake[]) {
  const calls: { max_tokens: number; messages: unknown[]; system: unknown }[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: { max_tokens: number; messages: unknown[]; system: unknown }) {
          calls.push({ max_tokens: params.max_tokens, messages: [...params.messages], system: params.system });
          const r = responses.shift();
          if (!r) throw new Error("no more responses");
          return {
            finalMessage: async () => ({
              model: "claude-opus-5-5",
              stop_reason: r.stop_reason,
              content: [{ type: "text", text: r.text }],
              usage: r.usage ?? { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const req = { stage: "ats" as const, system: "sys", user: "data\n<<<STAGE_TASK>>>\ntask", schema: Schema, effort: "medium" as const, maxTokens: 1000 };

describe("addUsage", () => {
  it("usage.iterations가 있으면 시도별 값을 모두 더한다(fallback 전 거절된 시도 포함)", () => {
    const msg = {
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          { type: "message", input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
          { type: "fallback_message", input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    };
    expect(addUsage(ZERO, msg as never)).toEqual({ inputTokens: 105, outputTokens: 47, cacheReadTokens: 3, cacheWriteTokens: 2 });
  });

  it("iterations가 없으면 top-level usage", () => {
    const msg = { usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } };
    expect(addUsage(ZERO, msg as never)).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 });
  });
});

describe("AnthropicLlmClient.generate", () => {
  it("max_tokens에서 끊기면 한도를 두 배로 올려 한 번 더 요청한다", async () => {
    const { client, calls } = fakeClient([
      { stop_reason: "max_tokens", text: '{"ok":' },
      { stop_reason: "end_turn", text: '{"ok":true}' },
    ]);
    const r = await new AnthropicLlmClient({ client, model: "m" }).generate(req);
    expect(r.output).toEqual({ ok: true });
    expect(calls.map((c) => c.max_tokens)).toEqual([1000, 2000]);
    expect(r.usage.outputTokens).toBe(200);
  });

  it("올린 한도에서도 끊기면 max_tokens 영구 오류이고, 쓴 토큰을 오류에 담는다", async () => {
    const { client } = fakeClient([
      { stop_reason: "max_tokens", text: "" },
      { stop_reason: "max_tokens", text: "" },
    ]);
    const err = await new AnthropicLlmClient({ client, model: "m" }).generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(LlmPermanentError);
    expect(err.reason).toBe("max_tokens");
    expect(usageOfError(err)?.outputTokens).toBe(200);
  });

  it("컨텍스트 초과는 별도 사유", async () => {
    const { client } = fakeClient([{ stop_reason: "model_context_window_exceeded", text: "" }]);
    const err = await new AnthropicLlmClient({ client, model: "m" }).generate(req).catch((e) => e);
    expect(err.reason).toBe("context_window");
  });

  it("스키마 불일치는 1회 재요청 후 invalid_output, 두 호출의 사용량을 모두 담는다", async () => {
    const { client, calls } = fakeClient([
      { stop_reason: "end_turn", text: '{"nope":1}' },
      { stop_reason: "end_turn", text: '{"nope":2}' },
    ]);
    const err = await new AnthropicLlmClient({ client, model: "m" }).generate(req).catch((e) => e);
    expect(err.reason).toBe("invalid_output");
    expect(calls).toHaveLength(2);
    expect(usageOfError(err)?.inputTokens).toBe(20);
  });

  it("거절도 사용량을 담는다", async () => {
    const { client } = fakeClient([{ stop_reason: "refusal", text: "" }]);
    const err = await new AnthropicLlmClient({ client, model: "m" }).generate(req).catch((e) => e);
    expect(err.reason).toBe("refusal");
    expect(usageOfError(err)?.outputTokens).toBe(100);
  });
});
