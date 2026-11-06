import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addUsage, addUsageByModel, AnthropicLlmClient, userContent } from "./anthropic";
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

describe("addUsageByModel", () => {
  it("fallback이 일어나면 시도별 모델로 나눠 더한다(model이 없는 거절 시도는 요청 모델)", () => {
    const msg = {
      model: "claude-sonnet-5-5",
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          { type: "message", model: null, input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
          { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    };
    const first = addUsageByModel([], msg as never, "claude-opus-5-5");
    expect(first).toEqual([
      { model: "claude-opus-5-5", usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 3, cacheWriteTokens: 2 } },
      { model: "claude-sonnet-5-5", usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);
    // 재요청(스키마 재시도 등)은 같은 모델 칸에 더한다.
    const plain = { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    expect(addUsageByModel(first, plain as never, "claude-opus-5-5")[0].usage.inputTokens).toBe(101);
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

describe("userContent 캐시 지점", () => {
  it("구분자 앞에만 캐시 지점을 두고, cache=false면 두지 않는다", async () => {
    const { STAGE_TASK_DELIMITER } = await import("@/lib/panel/prompts");
    const user = `고정 자료${STAGE_TASK_DELIMITER}대화`;
    expect(userContent(user)).toEqual([
      { type: "text", text: "고정 자료", cache_control: { type: "ephemeral" } },
      { type: "text", text: "대화" },
    ]);
    expect(userContent("한 번만 쓰는 본문", false)).toEqual([{ type: "text", text: "한 번만 쓰는 본문" }]);
    expect(userContent(user, false)[0]).not.toHaveProperty("cache_control");
  });
});

describe("구조화 출력 문법이 너무 큰 스키마", () => {
  it("문법 크기 400이면 스키마 강제 없이 다시 보내고, 코드 블록으로 감싼 JSON도 읽는다(이후 같은 스키마는 바로 강제 없이)", async () => {
    const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
    const BigSchema = z.object({ ok: z.boolean() });
    const calls: { format: unknown; system: string }[] = [];
    const replies = ["```json\n{\"ok\":true}\n```", '{"ok":false}'];
    const client = {
      beta: {
        messages: {
          stream(params: { output_config: { format?: unknown }; system: { text: string }[] }) {
            calls.push({ format: params.output_config.format, system: params.system[0]!.text });
            if (params.output_config.format) {
              throw new AnthropicSdk.BadRequestError(
                400,
                { type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues." } },
                "The compiled grammar is too large, which would cause performance issues.",
                new Headers(),
              );
            }
            const text = replies.shift()!;
            return {
              finalMessage: async () => ({
                model: "m",
                stop_reason: "end_turn",
                content: [{ type: "text", text }],
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              }),
            };
          },
        },
      },
    } as unknown as Anthropic;
    const llm = new AnthropicLlmClient({ client, model: "m" });
    expect((await llm.generate({ ...req, schema: BigSchema })).output).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.format).toBeTruthy();
    expect(calls[1]!.format).toBeUndefined();
    expect(calls[1]!.system).toContain("JSON Schema");
    // 두 번째 요청부터는 처음부터 강제 없이 보낸다.
    expect((await llm.generate({ ...req, schema: BigSchema })).output).toEqual({ ok: false });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.format).toBeUndefined();
  });
});
