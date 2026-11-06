/**
 * Claude API 구현체. 규칙은 ARCHITECTURE.md §5.
 *
 * - beta messages + 서버 측 거절 fallback(`fallbacks: "default"`).
 * - 구조화 출력: zod → JSON schema(toStrictJsonSchema)로 `output_config.format`에 넣고, 파싱·검증은 여기서
 *   req.schema로 직접 한다. 설치된 SDK의 betaZodOutputFormat은 enum까지 description으로 내려 버려
 *   판정 값(PASS/REJECT 등)이 강제되지 않으므로 쓰지 않는다.
 * - 스트리밍(`.stream().finalMessage()`): 재작성·계획 단계의 큰 max_tokens에서도 SDK의 비스트리밍 10분 제한에
 *   걸리지 않도록 모든 단계에서 스트리밍을 쓴다. 출력은 finalMessage로 한 번에 받는다.
 * - thinking·temperature는 보내지 않는다. 깊이는 output_config.effort로만 조절한다.
 *   Opus 5.5는 thinking이 항상 켜져 있고 thinking 토큰도 max_tokens에 들어가므로 단계별 max_tokens를 넉넉히 잡고,
 *   그래도 max_tokens에서 끊기면 한도를 두 배(최대 MAX_OUTPUT_TOKENS)로 올려 한 번 더 요청한다.
 * - 사용량: fallback이 일어나면 top-level usage는 마지막 시도만 담으므로 usage.iterations(시도별)를 합산한다.
 *   실패로 끝나도 그때까지의 사용량을 오류 객체의 usage에 붙여 진단 사용량에 반영되게 한다.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { splitUserPrompt } from "@/lib/panel/prompts";
import {
  LlmPermanentError,
  type LlmRequest,
  requestLabel,
  type GenerateResult,
  type LlmClient,
  type LlmUsage,
  type ModelUsage,
} from "./types";

export const DEFAULT_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_MAX_TOKENS = 32000;
/** 모델 출력 상한(Opus 5.5 128K). max_tokens 재시도는 여기까지만 올린다. */
const MAX_OUTPUT_TOKENS = 128000;

export function anthropicModelName(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

type Json = Record<string, unknown>;

/**
 * 구조화 출력이 지원하는 부분집합으로 변환한다: type/enum/const/anyOf/$ref/$defs/required/format 유지,
 * 객체는 additionalProperties=false, minItems는 0·1만. 그 밖의 제약(최소·최대값, maxItems 등)은
 * description에 적어 두고 실제 강제는 zod 재검증이 맡는다.
 */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Json;
  delete raw.$schema;
  return strict(raw);
}

const KEEP = new Set(["type", "enum", "const", "anyOf", "$ref", "$defs", "description", "title", "properties", "required", "items", "additionalProperties"]);
const STRING_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

function strict(node: Json): Json {
  const out: Json = {};
  const extra: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs" && value && typeof value === "object") {
      out.$defs = Object.fromEntries(Object.entries(value as Record<string, Json>).map(([k, v]) => [k, strict(v)]));
    } else if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, Json>).map(([k, v]) => [k, strict(v)]));
    } else if (key === "items" && value && typeof value === "object" && !Array.isArray(value)) {
      out.items = strict(value as Json);
    } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
      out.anyOf = (value as Json[]).map(strict);
    } else if (key === "additionalProperties") {
      // 아래에서 객체면 false로 고정
    } else if (key === "minItems" && (value === 0 || value === 1)) {
      out.minItems = value;
    } else if (key === "format" && typeof value === "string" && STRING_FORMATS.has(value)) {
      out.format = value;
    } else if (KEEP.has(key)) {
      out[key] = value;
    } else if (!(key === "maximum" && value === Number.MAX_SAFE_INTEGER) && !(key === "minimum" && value === Number.MIN_SAFE_INTEGER)) {
      extra.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  if (out.type === "object") out.additionalProperties = false;
  if (extra.length) out.description = [out.description, `{${extra.join(", ")}}`].filter(Boolean).join("\n\n");
  return out;
}

// 변환 결과를 스키마 객체별로 캐시한다(동일 바이트 유지 → 프롬프트 캐시 유지).
const formatCache = new WeakMap<object, BetaJSONOutputFormat>();
/**
 * 구조화 출력 문법이 너무 크다고 API가 거절한 스키마("The compiled grammar is too large").
 * 이런 스키마는 output_config.format 없이 보내고, 스키마는 시스템 지시문에 JSON으로 실어 응답을 zod로 검증한다
 * (검증 실패 시 기존처럼 1회 재요청).
 */
const grammarTooLarge = new WeakSet<object>();

/** 문법 크기 때문에 거절된 400인가. */
export function isGrammarTooLargeError(message: string): boolean {
  return /compiled grammar is too large/i.test(message);
}

/** 스키마 강제 없이 보낼 때 시스템 지시문 뒤에 붙이는 출력 규칙. */
export function schemaInstruction(schema: z.ZodType): string {
  return `\n\n# 출력 형식\n다음 JSON Schema에 정확히 맞는 JSON 객체 하나만 출력한다. 코드 블록(\`\`\`)·설명 문장 없이 JSON만 쓴다. 모든 필드를 빠짐없이 쓰고(없으면 빈 문자열·빈 배열), description의 {maxLength}·{maxItems} 한도를 지킨다.\n${JSON.stringify(toStrictJsonSchema(schema))}`;
}

function outputFormat(schema: z.ZodType): BetaJSONOutputFormat {
  let f = formatCache.get(schema);
  if (!f) {
    f = { type: "json_schema", schema: toStrictJsonSchema(schema) };
    formatCache.set(schema, f);
  }
  return f;
}

/**
 * 공유 자료 블록(앞)과 단계 지시·대화(뒤)를 나눠 앞 블록에 캐시 지점을 둔다. 구분자가 없으면 user 전체가 한 블록이다.
 * cache=false면 캐시 지점을 두지 않는다(한 번만 쓰는 호출에 쓰기 할증만 붙지 않게).
 */
export function userContent(user: string, cache = true): BetaTextBlockParam[] {
  const [shared, task] = splitUserPrompt(user);
  if (!cache) return [{ type: "text", text: task == null ? user : `${shared}\n${task}` }];
  if (task == null) return [{ type: "text", text: user, cache_control: { type: "ephemeral" } }];
  return [
    { type: "text", text: shared, cache_control: { type: "ephemeral" } },
    { type: "text", text: task },
  ];
}

type UsageLike = {
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * 응답 하나의 사용량을 더한다. usage.iterations가 있으면(서버 측 fallback 등 여러 시도) 시도별 값을 모두 합한다 —
 * top-level usage는 마지막 시도만 담기 때문이다. 없으면 top-level 값을 쓴다.
 */
export function addUsage(acc: LlmUsage, msg: Pick<BetaMessage, "usage">): LlmUsage {
  const iterations = (msg.usage as { iterations?: UsageLike[] | null }).iterations;
  const parts: UsageLike[] = iterations && iterations.length > 0 ? iterations : [msg.usage as UsageLike];
  let out = acc;
  for (const u of parts) {
    out = {
      inputTokens: out.inputTokens + (u.input_tokens ?? 0),
      outputTokens: out.outputTokens + (u.output_tokens ?? 0),
      cacheReadTokens: out.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
      cacheWriteTokens: out.cacheWriteTokens + (u.cache_creation_input_tokens ?? 0),
    };
  }
  return out;
}

/**
 * 모델별 사용량을 더한다(비용 추정용). iterations 항목에 model이 있으면 그 모델로 매긴다. 없으면 fallback이 일어난 응답의
 * 'message' 항목은 거절한 요청 모델(requestedModel), 그 밖에는 응답 모델(msg.model)로 매긴다.
 */
export function addUsageByModel(acc: ModelUsage[], msg: Pick<BetaMessage, "usage" | "model">, requestedModel: string): ModelUsage[] {
  const iterations = (msg.usage as { iterations?: (UsageLike & { type?: string })[] | null }).iterations;
  const parts: (UsageLike & { type?: string })[] = iterations && iterations.length > 0 ? iterations : [msg.usage as UsageLike];
  const fellBack = parts.some((u) => u.type === "fallback_message");
  const out = acc.map((m) => ({ model: m.model, usage: { ...m.usage } }));
  for (const u of parts) {
    const model = u.model || (fellBack && u.type === "message" ? requestedModel : msg.model) || requestedModel;
    let slot = out.find((m) => m.model === model);
    if (!slot) {
      slot = { model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      out.push(slot);
    }
    slot.usage.inputTokens += u.input_tokens ?? 0;
    slot.usage.outputTokens += u.output_tokens ?? 0;
    slot.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    slot.usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  }
  return out;
}

/**
 * 응답 텍스트 후보. 스트리밍 중 fallback이 일어나면 거절 전 부분 출력과 fallback 블록이 content에 남으므로
 * 전체 이어붙인 것과 마지막 fallback 블록 뒤의 텍스트를 모두 시도한다.
 */
function textCandidates(content: BetaContentBlock[]): string[] {
  const texts = (blocks: BetaContentBlock[]) =>
    blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const all = texts(content);
  const lastFallback = content.findLastIndex((b) => b.type === "fallback");
  const out = [all];
  if (lastFallback >= 0) {
    const after = texts(content.slice(lastFallback + 1));
    if (after && after !== all) out.unshift(after);
  }
  return out.filter((t) => t.trim().length > 0);
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

function parseOutput<T>(content: BetaContentBlock[], schema: z.ZodType<T>): ParseOutcome<T> {
  const candidates = textCandidates(content);
  if (candidates.length === 0) return { ok: false, problem: "응답에 텍스트가 없습니다." };
  let problem = "";
  for (const text of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      // 스키마 강제 없이 받은 응답은 코드 블록이나 앞뒤 문장이 붙을 수 있다 — 가장 바깥 { … }만 다시 읽어 본다.
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      try {
        if (start < 0 || end <= start) throw e;
        raw = JSON.parse(text.slice(start, end + 1));
      } catch {
        problem = `JSON 파싱 실패: ${(e as Error).message}`;
        continue;
      }
    }
    const r = schema.safeParse(raw);
    if (r.success) return { ok: true, value: r.data };
    problem = r.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
  }
  return { ok: false, problem };
}

export class AnthropicLlmClient implements LlmClient {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts?: { client?: Anthropic; model?: string }) {
    // 429·5xx·연결 오류는 SDK 재시도에 맡긴다.
    this.client = opts?.client ?? new Anthropic({ maxRetries: 4 });
    this.model = opts?.model ?? anthropicModelName();
  }

  async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let usageByModel: ModelUsage[] = [];
    try {
      const result = await this.generateInner(req, (msg) => {
        usage = addUsage(usage, msg);
        usageByModel = addUsageByModel(usageByModel, msg, this.model);
        return usage;
      });
      return { ...result, usageByModel };
    } catch (e) {
      // 실패해도 이미 쓴 토큰은 남긴다(runner가 진단 사용량에 더한다). 모델별 사용량은 비용 추정(llm_usage_events)용.
      if (e && typeof e === "object") {
        try {
          if ((e as { usage?: unknown }).usage === undefined) (e as { usage?: LlmUsage }).usage = usage;
          if ((e as { usageByModel?: unknown }).usageByModel === undefined && usageByModel.length > 0) {
            (e as { usageByModel?: ModelUsage[] }).usageByModel = usageByModel;
          }
        } catch {
          // 고정된 오류 객체면 무시
        }
      }
      throw e;
    }
  }

  private async generateInner<T>(
    req: LlmRequest<T>,
    record: (msg: BetaMessage) => LlmUsage,
  ): Promise<GenerateResult<T>> {
    const messages: BetaMessageParam[] = [{ role: "user", content: userContent(req.user, req.cacheUser !== false) }];
    let maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    let usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let raisedLimit = false;
    let schemaRetried = false;

    // 스키마 검증 실패는 1회 재요청, max_tokens 끊김은 한도를 올려 1회 재요청한다.
    for (let attempt = 0; attempt < 3; attempt++) {
      const msg = await this.call(req, messages, maxTokens);
      usage = record(msg);

      if (msg.stop_reason === "refusal") {
        throw new LlmPermanentError(`모델이 응답을 거절했습니다 (${requestLabel(req)})`, "refusal", usage);
      }
      if (msg.stop_reason === "model_context_window_exceeded") {
        throw new LlmPermanentError(`입력이 모델 컨텍스트를 넘었습니다 (${requestLabel(req)})`, "context_window", usage);
      }
      if (msg.stop_reason === "max_tokens") {
        if (!raisedLimit && maxTokens < MAX_OUTPUT_TOKENS) {
          raisedLimit = true;
          maxTokens = Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2);
          continue;
        }
        throw new LlmPermanentError(`응답이 출력 한도(${maxTokens})에서 끊겼습니다 (${requestLabel(req)})`, "max_tokens", usage);
      }

      const parsed = parseOutput(msg.content, req.schema);
      if (parsed.ok) return { output: parsed.value, usage, model: msg.model };
      if (schemaRetried) break;
      schemaRetried = true;

      const previous = textCandidates(msg.content)[0] ?? "";
      if (previous) {
        messages.push(
          { role: "assistant", content: previous },
          {
            role: "user",
            content: `방금 출력이 스키마 검증을 통과하지 못했다:\n${parsed.problem}\n\n같은 내용을 스키마에 정확히 맞는 JSON 하나로 다시 출력한다.`,
          },
        );
      }
      // 빈 응답이면 같은 요청을 그대로 다시 보낸다.
    }
    throw new LlmPermanentError(`모델 출력이 스키마와 맞지 않습니다 (${requestLabel(req)})`, "invalid_output", usage);
  }

  private async call<T>(req: LlmRequest<T>, messages: BetaMessageParam[], maxTokens: number): Promise<BetaMessage> {
    const send = async (constrained: boolean) => {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          system: [
            { type: "text", text: constrained ? req.system : req.system + schemaInstruction(req.schema), cache_control: { type: "ephemeral" } },
          ],
          messages,
          output_config: constrained ? { effort: req.effort, format: outputFormat(req.schema) } : { effort: req.effort },
        },
        { signal: req.signal },
      );
      return await stream.finalMessage();
    };
    try {
      if (grammarTooLarge.has(req.schema)) return await send(false);
      try {
        return await send(true);
      } catch (e) {
        // 문법이 너무 크다는 거절은 토큰을 쓰기 전에 난다 — 이 스키마는 앞으로 스키마 강제 없이 보낸다.
        if (e instanceof Anthropic.BadRequestError && isGrammarTooLargeError(e.message)) {
          grammarTooLarge.add(req.schema);
          console.warn(`[llm] structured output grammar too large; retrying without format (${requestLabel(req)})`);
          return await send(false);
        }
        throw e;
      }
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        throw new LlmPermanentError(`요청이 거부되었습니다: ${e.message}`, "bad_request");
      }
      throw e;
    }
  }
}
