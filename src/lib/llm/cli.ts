/**
 * CLI 엔진 구현체(서버 전용): 로컬 `claude`(Claude 구독 로그인)·`codex`(ChatGPT 로그인)를 자식 프로세스로 실행한다.
 * 로그인은 lib/providers/service.ts가 앱 전용 CLI 홈에 만들어 두고, 여기서는 같은 홈으로 호출만 한다.
 *
 * 공통 규칙(Claude API 구현체와 같은 계약):
 * - 단계 지시문(system)·자료(user)·zod 스키마를 받아 스키마를 통과한 출력만 돌려준다.
 * - 스키마 검증 실패는 1회 재요청(검증 오류를 덧붙여), 일시 오류(과부하 등)는 잠시 뒤 1회 재시도.
 * - 로그인 없음·만료 → LlmPermanentError("auth"), 구독 한도 → "usage_limit", 미설치 → "unavailable".
 * - 도구는 쓰지 않는다: claude는 `--tools ""`, codex는 읽기 전용 샌드박스 + 빈 작업 폴더.
 * - 동시에 띄우는 CLI 프로세스 수를 CLI_MAX_CONCURRENCY(기본 4)로 묶는다(CLI 하나가 수백 MB를 쓴다).
 */
import "server-only";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { CliNotInstalledError, cliProvidersEnabled, cliWorkDir, runCli } from "@/lib/providers/cli";
import { looksLikeAuthError, looksLikeTransientOverload, looksLikeUsageLimit } from "@/lib/providers/parse";
import type { CliProviderId } from "@/lib/domain/providers";
import { DEFAULT_MODEL, toStrictJsonSchema } from "./anthropic";
import {
  looksLikeRefusal,
  parseClaudeResult,
  parseCodexEvents,
  sumUsage,
  validateOutput,
  ZERO_USAGE,
  type CliTurn,
} from "./cli-output";
import { LlmPermanentError, type Effort, type GenerateRequest, type GenerateResult, type LlmClient, type LlmUsage } from "./types";

export function claudeCliModel(): string {
  return process.env.CLAUDE_CLI_MODEL?.trim() || DEFAULT_MODEL;
}

/** 비우면 codex 설정의 기본 모델. */
export function codexCliModel(): string | null {
  return process.env.CODEX_CLI_MODEL?.trim() || null;
}

function callTimeoutMs(): number {
  const n = Number(process.env.CLI_CALL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
}

// ---- 동시 실행 제한 ----
const g = globalThis as unknown as { __cliSlots?: { active: number; queue: (() => void)[] } };
const slots = (g.__cliSlots ??= { active: 0, queue: [] });

function maxConcurrency(): number {
  const n = Number(process.env.CLI_MAX_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

async function withSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (slots.active >= maxConcurrency()) {
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = slots.queue.indexOf(go);
        if (i >= 0) slots.queue.splice(i, 1);
        reject(signal!.reason);
      };
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      slots.queue.push(go);
    });
  }
  slots.active++;
  try {
    return await fn();
  } finally {
    slots.active--;
    slots.queue.shift()?.();
  }
}

// ---- 스키마 ----
const schemaJsonCache = new WeakMap<object, string>();
function schemaJson(schema: z.ZodType): string {
  let s = schemaJsonCache.get(schema);
  if (!s) {
    s = JSON.stringify(toStrictJsonSchema(schema));
    schemaJsonCache.set(schema, s);
  }
  return s;
}

/** codex는 스키마를 파일로 받는다. 프로세스 전용 작업 폴더(cliWorkDir)에 내용 해시 이름으로 한 번만 쓴다. */
const schemaFiles = new Map<string, string>();
function schemaFile(schema: z.ZodType): string {
  const json = schemaJson(schema);
  const name = `schema-${createHash("sha256").update(json).digest("hex").slice(0, 16)}.json`;
  let file = schemaFiles.get(name);
  if (!file) {
    file = path.join(cliWorkDir(), name);
    try {
      writeFileSync(file, json, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    schemaFiles.set(name, file);
  }
  return file;
}

// ---- 공통 실행 루프 ----
type Turn = (input: string) => Promise<CliTurn & { timedOut: boolean; stderr: string }>;

type WithUsage = Error & { usage?: LlmUsage; status?: number; reason?: unknown };

/** 실패 오류에 이번 호출의 사용량을 붙인다. 공유 오류 객체(중단 사유)는 건드리지 않고 이름·사유를 유지한 새 오류로 감싼다. */
function withUsage(e: unknown, usage: LlmUsage): unknown {
  if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) return e;
  const src = e as WithUsage | null;
  const wrapped = new Error(src?.message ?? String(e), { cause: e }) as WithUsage;
  wrapped.name = src?.name ?? "Error";
  if (src?.reason !== undefined) wrapped.reason = src.reason;
  wrapped.usage = usage;
  return wrapped;
}

async function generateWithCli<T>(provider: CliProviderId, req: GenerateRequest<T>, turn: Turn, fallbackModel: string): Promise<GenerateResult<T>> {
  if (!cliProvidersEnabled()) throw new LlmPermanentError("CLI 엔진이 꺼져 있습니다", "unavailable");
  const who = provider === "claude-cli" ? "Claude" : "ChatGPT";
  let usage: LlmUsage = ZERO_USAGE;
  let input = req.user;
  let schemaRetried = false;
  let transientRetried = false;
  const retrySchema = (problem: string): boolean => {
    if (schemaRetried) return false;
    schemaRetried = true;
    input = `${req.user}\n\n[이전 출력 오류]\n방금 출력이 스키마 검증을 통과하지 못했다:\n${problem}\n같은 내용을 스키마에 정확히 맞는 JSON 하나로 다시 출력한다.`;
    return true;
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    let r: Awaited<ReturnType<Turn>>;
    try {
      r = await withSlot(req.signal, () => turn(input));
    } catch (e) {
      if (e instanceof CliNotInstalledError) throw new LlmPermanentError(e.message, "unavailable", usage);
      throw withUsage(e, usage);
    }
    usage = sumUsage(usage, r.usage);
    if (r.timedOut) throw new LlmPermanentError(`CLI 응답 시간 초과 (${req.stage})`, "timeout", usage);

    // 도구를 쓴 응답은 내용이 무엇이든 버린다(이력서에 심은 지시로 서버 파일을 읽어 보고서로 빼내는 것을 막는다).
    if (r.toolItems.length > 0) {
      throw new LlmPermanentError(`모델이 허용되지 않은 도구를 사용했습니다: ${r.toolItems.join(", ")} (${req.stage})`, "invalid_output", usage);
    }

    if (r.value == null && r.cliError != null) {
      // 로그인·한도 판정은 CLI 오류와 stderr로만 한다(모델이 쓴 글로 판정하지 않는다).
      const text = `${r.cliError}\n${r.stderr.slice(-2000)}`;
      if (looksLikeAuthError(text)) throw new LlmPermanentError(`${who} 계정 로그인이 필요합니다 (${req.stage})`, "auth", usage);
      if (looksLikeUsageLimit(text)) throw new LlmPermanentError(`${who} 사용량 한도 (${req.stage})`, "usage_limit", usage);
      if (!transientRetried) {
        transientRetried = true;
        await new Promise((res) => setTimeout(res, looksLikeTransientOverload(text) ? 15_000 : 3000));
        continue;
      }
      const err = new Error(`CLI 호출 실패 (${req.stage}): ${r.cliError.slice(0, 300)}`) as WithUsage;
      // 과부하로 끝나면 '일시적 장애' 문구(runner의 stageErrorMessage)가 나오도록 상태를 붙인다.
      if (looksLikeTransientOverload(text)) err.status = 529;
      err.usage = usage;
      throw err;
    }

    if (r.value == null) {
      // 모델은 응답했지만 JSON이 아니다: 거절이면 거절로, 아니면 스키마 재요청.
      if (looksLikeRefusal(r.modelText ?? "")) throw new LlmPermanentError(`모델이 응답을 거절했습니다 (${req.stage})`, "refusal", usage);
      if (retrySchema("JSON 출력이 없거나 JSON 형식이 아니다.")) continue;
      break;
    }

    const v = validateOutput(r.value, req.schema);
    if (v.ok) return { output: v.value, usage, model: r.model ?? fallbackModel };
    if (!retrySchema(v.problem)) break;
  }
  throw new LlmPermanentError(`모델 출력이 스키마와 맞지 않습니다 (${req.stage})`, "invalid_output", usage);
}

// ---- Claude Code CLI ----
export class ClaudeCliLlmClient implements LlmClient {
  readonly name = "claude-cli";
  constructor(private readonly model: string = claudeCliModel()) {}

  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.model,
      "--effort",
      req.effort,
      "--system-prompt",
      req.system,
      "--json-schema",
      schemaJson(req.schema),
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--max-turns",
      "6",
    ];
    return generateWithCli(
      "claude-cli",
      req,
      async (input) => {
        const r = await runCli("claude-cli", args, { stdin: input, signal: req.signal, timeoutMs: callTimeoutMs() });
        return { ...parseClaudeResult(r.stdout), timedOut: r.timedOut, stderr: r.stderr };
      },
      this.model,
    );
  }
}

// ---- Codex CLI ----
/** codex의 reasoning effort 단계(low·medium·high)로 맞춘다. */
export function codexEffort(effort: Effort): "low" | "medium" | "high" {
  return effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
}

/** 심사에 필요 없는 codex 도구 기능(codex-cli 0.162 기준). 없는 이름은 codex가 무시한다. */
const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "hooks",
  "view_image",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies",
];

const CODEX_PREAMBLE =
  "[실행 규칙] 너는 코딩 에이전트가 아니라 아래 지시를 따르는 심사위원이다. 셸 명령·파일 읽기·웹 검색 같은 도구를 쓰지 않는다. " +
  "주어진 자료만 근거로 판단하고, 최종 답변으로 지정된 JSON 스키마에 맞는 JSON 하나만 출력한다.";

export class CodexCliLlmClient implements LlmClient {
  readonly name = "codex-cli";
  constructor(private readonly model: string | null = codexCliModel()) {}

  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--json",
      "--output-schema",
      schemaFile(req.schema),
      "-c",
      `model_reasoning_effort="${codexEffort(req.effort)}"`,
      "-c",
      "project_doc_max_bytes=0",
      // 도구를 설정으로 끈다(프롬프트 지시에만 기대지 않는다). 남은 경로(code mode)는 host를 꺼서 실패하게 둔다.
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
      "-c",
      "mcp_servers={}",
      "-c",
      'web_search="disabled"',
      ...(this.model ? ["-m", this.model] : []),
      "-",
    ];
    return generateWithCli(
      "codex-cli",
      req,
      async (input) => {
        const prompt = `${CODEX_PREAMBLE}\n\n[지시]\n${req.system}\n\n[자료와 과제]\n${input}`;
        const r = await runCli("codex-cli", args, { stdin: prompt, signal: req.signal, timeoutMs: callTimeoutMs() });
        return { ...parseCodexEvents(r.stdout), timedOut: r.timedOut, stderr: r.stderr };
      },
      this.model ?? "codex",
    );
  }
}
