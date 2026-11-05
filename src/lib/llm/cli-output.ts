/**
 * CLI 엔진 출력 해석(순수 함수, 테스트 대상).
 * - `claude -p --output-format json` : 결과 JSON 한 개(structured_output·usage·modelUsage·is_error).
 * - `codex exec --json`              : 이벤트 JSONL(item.completed의 agent_message, turn.completed의 usage, turn.failed).
 */
import type { z } from "zod";
import type { LlmUsage } from "./types";

export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function sumUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface CliTurn {
  /** 모델이 낸 구조화 출력(파싱 전 값). 없으면 null. */
  value: unknown;
  /**
   * CLI·전송 계층 오류(로그인 없음, 한도, 네트워크 등). 로그인·한도 판정은 이 값과 stderr로만 한다 —
   * 모델이 쓴 글(이력서 인용 등)에 '401'·'limit' 같은 말이 있어도 오판하지 않도록.
   */
  cliError: string | null;
  /** 모델이 응답은 했지만 쓸 수 없을 때(JSON 아님·구조화 출력 없음) 그 내용. 스키마 재요청으로 처리한다. */
  modelText: string | null;
  /** 모델이 도구(셸·MCP·웹 등)를 쓴 흔적. 있으면 출력을 버린다. */
  toolItems: string[];
  usage: LlmUsage;
  model: string | null;
}

/** `claude -p --output-format json` stdout. */
export function parseClaudeResult(stdout: string): CliTurn {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return {
      value: null,
      cliError: stdout.trim().slice(-2000) || "CLI 출력 없음",
      modelText: null,
      toolItems: [],
      usage: ZERO_USAGE,
      model: null,
    };
  }
  const u = (j.usage ?? {}) as Record<string, unknown>;
  const usage: LlmUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
  const models = j.modelUsage && typeof j.modelUsage === "object" ? Object.keys(j.modelUsage) : [];
  const model = models[0] ?? null;
  const resultText = typeof j.result === "string" ? j.result : "";
  const base = { toolItems: [] as string[], usage, model };
  if (j.is_error === true || (typeof j.subtype === "string" && j.subtype !== "success")) {
    const status = j.api_error_status != null ? ` (status ${String(j.api_error_status)})` : "";
    return { ...base, value: null, cliError: `${resultText || String(j.subtype ?? "error")}${status}`, modelText: null };
  }
  if (j.structured_output != null) return { ...base, value: j.structured_output, cliError: null, modelText: null };
  // 구조화 출력이 비어 있으면 결과 텍스트가 JSON인지 본다.
  try {
    return { ...base, value: JSON.parse(resultText), cliError: null, modelText: null };
  } catch {
    return { ...base, value: null, cliError: null, modelText: resultText || "" };
  }
}

/** `codex exec --json` stdout(JSONL). 마지막 agent_message를 JSON으로 읽는다. */
export function parseCodexEvents(stdout: string): CliTurn {
  let message: string | null = null;
  let failure: string | null = null;
  const toolItems: string[] = [];
  let lastError: string | null = null;
  let usage = ZERO_USAGE;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type === "item.completed") {
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") message = item.text;
      else if (typeof item.type === "string" && !SAFE_CODEX_ITEMS.has(item.type)) toolItems.push(item.type);
    } else if (e.type === "item.started") {
      const item = (e.item ?? {}) as Record<string, unknown>;
      if (typeof item.type === "string" && !SAFE_CODEX_ITEMS.has(item.type)) toolItems.push(item.type);
    } else if (e.type === "turn.completed") {
      const u = (e.usage ?? {}) as Record<string, unknown>;
      const cached = num(u.cached_input_tokens);
      usage = sumUsage(usage, {
        // codex의 input_tokens는 캐시 적중분을 포함한다. 다른 엔진과 같게 '캐시 아닌 입력'으로 나눈다.
        inputTokens: Math.max(0, num(u.input_tokens) - cached),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: cached,
        cacheWriteTokens: num(u.cache_write_input_tokens),
      });
    } else if (e.type === "turn.failed") {
      const err = (e.error ?? {}) as Record<string, unknown>;
      failure = typeof err.message === "string" ? err.message : "turn failed";
    } else if (e.type === "error" && typeof e.message === "string") {
      lastError = e.message;
    }
  }
  const base = { toolItems: [...new Set(toolItems)], usage, model: null };
  if (failure || message == null) {
    return { ...base, value: null, cliError: failure ?? lastError ?? "빈 응답", modelText: null };
  }
  try {
    return { ...base, value: JSON.parse(message), cliError: null, modelText: null };
  } catch {
    return { ...base, value: null, cliError: null, modelText: message };
  }
}

/** 도구 사용이 아닌 codex 항목. 그 밖(command_execution·mcp_tool_call·web_search·file_change 등)은 도구 사용으로 본다. */
const SAFE_CODEX_ITEMS = new Set(["agent_message", "reasoning", "error", "todo_list"]);

/** 모델이 쓴 글이 거절인가(짧고 거절 표현). CLI 오류 문구에는 쓰지 않는다. */
export function looksLikeRefusal(modelText: string): boolean {
  const t = modelText.trim();
  return t.length > 0 && t.length < 600 && /\b(?:I can(?:no|')t|I(?:'m| am) (?:not able|unable) to|I won't|I must decline)\b|도와드릴 수 없|응답할 수 없|거절/i.test(t);
}

export type Validated<T> = { ok: true; value: T } | { ok: false; problem: string };

export function validateOutput<T>(value: unknown, schema: z.ZodType<T>): Validated<T> {
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    problem: r.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n"),
  };
}
