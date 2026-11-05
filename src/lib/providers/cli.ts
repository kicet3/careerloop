/**
 * 로컬 CLI(claude·codex) 실행 공통부. 서버 전용.
 *
 * 로그인 격리: 앱은 CLI 로그인을 사용자의 개인 CLI 설정과 분리된 전용 홈에 둔다.
 *   claude → CLAUDE_CONFIG_DIR=<CLI_PROVIDER_HOME>/claude, codex → CODEX_HOME=<CLI_PROVIDER_HOME>/codex
 * 그래서 웹에서 로그아웃해도 이 PC의 개인 Claude Code·Codex 로그인은 건드리지 않는다.
 * CLAUDE_CLI_CONFIG_DIR / CODEX_CLI_HOME에 경로를 주면 그 경로를, "system"을 주면 이 PC의 기본 로그인을 그대로 쓴다
 * (system일 때는 웹에서 로그인·로그아웃을 막는다).
 */
import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isProduction } from "@/lib/config/env";
import type { CliProviderId } from "@/lib/domain/providers";

/**
 * CLI 엔진 사용 여부. 임시·개인용 기능이라 CLI_PROVIDERS=1로 명시적으로 켜야 한다.
 * APP_ENV=PRODUCTION이면 한 서버 계정의 구독을 모든 사용자가 쓰게 되므로 CLI_PROVIDERS_IN_PRODUCTION=1까지 있어야 켠다.
 */
export function cliProvidersEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.CLI_PROVIDERS !== "1") return false;
  return !isProduction(env) || env.CLI_PROVIDERS_IN_PRODUCTION === "1";
}

export function cliBinary(provider: CliProviderId): string {
  if (provider === "claude-cli") return process.env.CLAUDE_CLI_PATH?.trim() || "claude";
  return process.env.CODEX_CLI_PATH?.trim() || "codex";
}

function providerRoot(): string {
  const raw = process.env.CLI_PROVIDER_HOME?.trim();
  return raw ? path.resolve(raw) : path.join(/* turbopackIgnore: true */ process.cwd(), "data", "providers");
}

/** 이 엔진이 이 PC의 기본(개인) CLI 로그인을 그대로 쓰도록 설정됐는가. */
export function usesSystemLogin(provider: CliProviderId): boolean {
  const raw = provider === "claude-cli" ? process.env.CLAUDE_CLI_CONFIG_DIR : process.env.CODEX_CLI_HOME;
  return raw?.trim() === "system";
}

/** 앱 전용 CLI 홈 경로. system 모드면 null. */
export function cliHome(provider: CliProviderId): string | null {
  if (usesSystemLogin(provider)) return null;
  const raw = (provider === "claude-cli" ? process.env.CLAUDE_CLI_CONFIG_DIR : process.env.CODEX_CLI_HOME)?.trim();
  const dir = raw ? path.resolve(raw) : path.join(providerRoot(), provider === "claude-cli" ? "claude" : "codex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const gp = globalThis as unknown as { __cliWorkDir?: string; __cliChildren?: Set<ChildProcess>; __cliExitHooks?: boolean };

/**
 * CLI 호출용 작업 디렉터리. 프로세스마다 mkdtemp로 새로 만든 0700 폴더라, 프로젝트 지시 파일(CLAUDE.md·AGENTS.md)이나
 * 다른 로컬 사용자가 미리 심어 둔 설정·심볼릭 링크가 끼어들 수 없다.
 */
export function cliWorkDir(): string {
  gp.__cliWorkDir ??= mkdtempSync(path.join(os.tmpdir(), "resume-panel-cli-"));
  return gp.__cliWorkDir;
}

// 자식 CLI에 넘기지 않을 환경 변수. API 키가 있으면 CLI가 구독 로그인 대신 키로 과금하고,
// 이 서버가 Claude Code 안에서 실행됐다면 중첩 세션 표식이 자식 동작을 바꾼다.
const STRIP_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "CLAUDECODE", "OPENAI_", "CODEX_", "CLAUDE_CONFIG_DIR"];
const APP_SECRETS = ["DATABASE_URL", "DATABASE_AUTH_TOKEN"];

/** 자식 CLI 환경: 서버 환경에서 키·중첩 표식을 빼고 전용 홈을 지정한다. */
export function cliEnv(provider: CliProviderId, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (STRIP_PREFIXES.some((p) => k.startsWith(p)) || APP_SECRETS.includes(k)) continue;
    env[k] = v;
  }
  const home = cliHome(provider);
  if (home) env[provider === "claude-cli" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = home;
  env.NO_COLOR = "1";
  // 서버 PC에서 브라우저 창을 띄우지 않는다(로그인 링크는 웹 화면에 보여 준다).
  env.BROWSER = process.platform === "win32" ? "echo" : "true";
  return { ...env, ...extra };
}

/**
 * 자식 CLI와 그 자손을 모두 끝낸다. npm으로 설치한 codex·claude는 Node 래퍼가 실제 바이너리를 또 띄우므로
 * 래퍼만 죽이면 자식이 남는다 — 그래서 detached(새 프로세스 그룹)로 띄우고 그룹 전체에 신호를 보낸다.
 */
const children = (gp.__cliChildren ??= new Set());

/** 띄운 CLI를 기억해 두었다가 서버가 끝날 때 함께 끝낸다(detached라 자동으로 같이 죽지 않는다). */
export function trackChild(child: ChildProcess): void {
  children.add(child);
  const forget = () => children.delete(child);
  child.once("close", forget);
  child.once("error", forget);
  if (gp.__cliExitHooks) return;
  gp.__cliExitHooks = true;
  const killAll = () => {
    for (const c of children) {
      if (c.pid == null || c.exitCode != null || c.signalCode != null) continue;
      try {
        if (process.platform === "win32") c.kill("SIGTERM");
        else process.kill(-c.pid, "SIGTERM");
      } catch {
        // 이미 끝남
      }
    }
  };
  process.on("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      killAll();
      // 다른 종료 처리기가 없으면 기본 동작(종료)을 이어간다.
      if (process.listenerCount(sig) === 0) process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null || child.pid == null) return;
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-pid, sig);
    } catch {
      // 이미 끝남
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 2000).unref?.();
}

/** spawn 공통 옵션: 빈 작업 폴더, 정리된 환경, 프로세스 그룹 분리(killProcessTree용). */
export function cliSpawnOptions(provider: CliProviderId, extraEnv?: Record<string, string>) {
  return {
    cwd: cliWorkDir(),
    env: cliEnv(provider, extraEnv) as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  };
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class CliNotInstalledError extends Error {
  constructor(readonly binary: string) {
    super(`${binary} CLI를 찾을 수 없습니다.`);
    this.name = "CliNotInstalledError";
  }
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * CLI를 한 번 실행하고 끝날 때까지 기다린다. stdin을 주면 쓰고 닫는다.
 * signal 중단·시간 초과면 프로세스를 끝낸다(시간 초과는 timedOut=true로 돌려주고, 중단은 signal.reason을 던진다).
 */
export function runCli(
  provider: CliProviderId,
  args: string[],
  opts: { stdin?: string; signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<CliRunResult> {
  const binary = cliBinary(provider);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason);
    const child = spawn(/* turbopackIgnore: true */ binary, args, cliSpawnOptions(provider, opts.env));
    trackChild(child);
    // 멀티바이트(한글) 문자가 청크 경계에서 깨지지 않도록 디코더에 맡긴다.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (s: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += s;
    });
    child.stderr.on("data", (s: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += s;
    });
    const kill = () => killProcessTree(child);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish(() => reject(err.code === "ENOENT" ? new CliNotInstalledError(binary) : err)),
    );
    child.on("close", (code) =>
      finish(() => {
        if (opts.signal?.aborted) reject(opts.signal.reason);
        else resolve({ code, stdout, stderr, timedOut });
      }),
    );
    child.stdin.on("error", () => undefined); // 자식이 먼저 끝나면 EPIPE — close에서 처리한다.
    child.stdin.end(opts.stdin ?? "");
  });
}
