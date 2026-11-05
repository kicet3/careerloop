/**
 * CLI 엔진 연결 관리(서버 전용): 로그인 상태 확인, 웹에서 시작하는 로그인 흐름, 로그아웃.
 *
 * 로그인 흐름은 paperclip(github.com/paperclipai/paperclip)의 claude-local·codex-local 어댑터 방식을 따른다 —
 * 공식 CLI의 로그인 명령을 자식 프로세스로 띄우고, 안내문에서 링크·코드를 뽑아 웹 화면에 보여 준다.
 *   - Claude: `claude auth login --claudeai` → 인가 링크 → 사용자가 브라우저에서 로그인 후 받은 코드를 붙여넣음
 *             → 서버가 자식 stdin으로 전달 → CLI가 토큰을 교환해 전용 CLAUDE_CONFIG_DIR에 저장.
 *   - ChatGPT: `codex login --device-auth` → 기기 인증 링크 + 1회용 코드 → 사용자가 브라우저에서 코드 입력
 *             → CLI가 완료를 감지해 전용 CODEX_HOME에 저장.
 * 토큰은 CLI가 자기 저장소에 보관하며 이 앱은 읽거나 DB에 저장하지 않는다. 로그인 안내문(링크·코드)도
 * 메모리에만 두고 로그에 남기지 않는다.
 *
 * 엔진별 로그인은 한 번에 하나만 진행한다(프로세스 전역 상태, 개발 서버 HMR에도 유지).
 */
import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CLI_PROVIDER_IDS,
  type CliProviderId,
  type CliStatus,
  type LoginPhase,
  type LoginView,
  type ProviderConnection,
} from "@/lib/domain/providers";
import {
  CliNotInstalledError,
  cliBinary,
  cliProvidersEnabled,
  cliSpawnOptions,
  killProcessTree,
  runCli,
  trackChild,
  usesSystemLogin,
} from "./cli";
import { ProviderServiceError } from "./errors";
import { parseClaudeAuthStatus, parseClaudeLoginPrompt, parseCodexDevicePrompt, parseCodexLoginStatus } from "./parse";

export { ProviderServiceError };

const LOGIN_TTL_MS = 15 * 60_000;
const STATUS_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 20_000;

interface LoginSession {
  child: ChildProcessWithoutNullStreams;
  output: string;
  view: LoginView;
  timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as unknown as {
  __providerLogins?: Map<CliProviderId, LoginSession>;
  __providerStatus?: Map<CliProviderId, { at: number; value: Promise<CliStatus> }>;
};
const logins = (g.__providerLogins ??= new Map());
const statusCache = (g.__providerStatus ??= new Map());

const UNKNOWN_STATUS = "로그인 상태를 확인하지 못했습니다. 잠시 뒤 [상태 새로고침]을 눌러 주세요.";

async function probeStatus(provider: CliProviderId): Promise<CliStatus> {
  try {
    if (provider === "claude-cli") {
      const r = await runCli(provider, ["auth", "status"], { timeoutMs: STATUS_TIMEOUT_MS });
      const s = parseClaudeAuthStatus(r.stdout);
      // 시간 초과·알아볼 수 없는 출력은 '로그아웃'이 아니라 '확인 실패'로 본다.
      if (r.timedOut || !s.parsed) return { installed: true, loggedIn: false, account: null, error: UNKNOWN_STATUS };
      // API 키 방식(console) 로그인은 구독 사용이 아니므로 연결로 보지 않는다.
      if (s.loggedIn && s.method && s.method !== "claude.ai") {
        return { installed: true, loggedIn: false, account: null, error: "Claude 구독(claude.ai) 계정으로 로그인해야 합니다." };
      }
      return { installed: true, loggedIn: s.loggedIn, account: s.account, error: null };
    }
    const r = await runCli(provider, ["login", "status"], { timeoutMs: STATUS_TIMEOUT_MS });
    const s = parseCodexLoginStatus(`${r.stdout}\n${r.stderr}`);
    if (r.timedOut || !s.recognized) return { installed: true, loggedIn: false, account: null, error: UNKNOWN_STATUS };
    return { installed: true, loggedIn: s.loggedIn, account: s.account, error: null };
  } catch (e) {
    if (e instanceof CliNotInstalledError) return { installed: false, loggedIn: false, account: null, error: e.message };
    return { installed: true, loggedIn: false, account: null, error: UNKNOWN_STATUS };
  }
}

/** 로그인 상태(30초 캐시, 확인 실패는 캐시하지 않는다). fresh면 새로 확인한다. */
export function getCliStatus(provider: CliProviderId, opts: { fresh?: boolean } = {}): Promise<CliStatus> {
  const hit = statusCache.get(provider);
  if (!opts.fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const entry = { at: Date.now(), value: probeStatus(provider) };
  statusCache.set(provider, entry);
  void entry.value.then((s) => {
    if (s.error === UNKNOWN_STATUS && statusCache.get(provider) === entry) statusCache.delete(provider);
  });
  return entry.value;
}

function invalidateStatus(provider: CliProviderId) {
  statusCache.delete(provider);
}

function viewOf(provider: CliProviderId): LoginView | null {
  const s = logins.get(provider);
  return s ? { ...s.view } : null;
}

export async function getConnection(provider: CliProviderId, opts: { fresh?: boolean } = {}): Promise<ProviderConnection> {
  const enabled = cliProvidersEnabled();
  return {
    id: provider,
    enabled,
    systemLogin: usesSystemLogin(provider),
    status: enabled
      ? await getCliStatus(provider, opts)
      : { installed: false, loggedIn: false, account: null, error: "CLI 엔진이 꺼져 있습니다(CLI_PROVIDERS=1)." },
    login: viewOf(provider),
  };
}

export async function listConnections(): Promise<ProviderConnection[]> {
  return Promise.all(CLI_PROVIDER_IDS.map((p) => getConnection(p)));
}

function assertManageable(provider: CliProviderId) {
  if (!cliProvidersEnabled()) throw new ProviderServiceError("CLI 엔진이 꺼져 있습니다. 서버 환경 변수 CLI_PROVIDERS=1이 필요합니다.", 404);
  if (usesSystemLogin(provider)) {
    throw new ProviderServiceError(
      "이 엔진은 서버 PC의 기본 CLI 로그인을 그대로 쓰도록 설정되어 있어 웹에서 로그인·로그아웃할 수 없습니다.",
      409,
    );
  }
}

function settle(provider: CliProviderId, session: LoginSession, phase: LoginPhase, message: string | null) {
  if (["succeeded", "failed", "cancelled"].includes(session.view.phase)) return;
  session.view = { ...session.view, phase, message };
  invalidateStatus(provider);
  clearTimeout(session.timer);
  killProcessTree(session.child);
  session.output = "";
  // 끝난 상태는 화면이 결과를 읽을 수 있게 잠시 남겨 둔다.
  session.timer = setTimeout(() => {
    if (logins.get(provider) === session) logins.delete(provider);
  }, 5 * 60_000);
  session.timer.unref?.();
}

/** 웹에서 로그인을 시작한다. 이미 진행 중이면 그 상태를 그대로 돌려준다. */
export async function startLogin(provider: CliProviderId): Promise<LoginView> {
  assertManageable(provider);
  const existing = logins.get(provider);
  if (existing && ["starting", "waiting", "verifying"].includes(existing.view.phase)) return { ...existing.view };

  const args = provider === "claude-cli" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(/* turbopackIgnore: true */ cliBinary(provider), args, cliSpawnOptions(provider));
  } catch {
    throw new ProviderServiceError(`${cliBinary(provider)} CLI를 실행하지 못했습니다.`, 500);
  }

  const session: LoginSession = {
    child,
    output: "",
    view: {
      phase: "starting",
      url: null,
      userCode: null,
      needsCode: provider === "claude-cli",
      codeSubmitted: false,
      message: null,
      expiresAt: Date.now() + LOGIN_TTL_MS,
    },
    timer: setTimeout(() => settle(provider, session, "failed", "로그인 시간(15분)이 지났습니다. 다시 시작해 주세요."), LOGIN_TTL_MS),
  };
  session.timer.unref?.();
  logins.set(provider, session);

  const onData = (chunk: string) => {
    if (session.view.phase !== "starting") return;
    session.output = (session.output + chunk).slice(-64 * 1024);
    if (provider === "claude-cli") {
      const p = parseClaudeLoginPrompt(session.output);
      if (p) session.view = { ...session.view, phase: "waiting", url: p.url };
    } else {
      const p = parseCodexDevicePrompt(session.output);
      if (p) session.view = { ...session.view, phase: "waiting", url: p.url, userCode: p.code };
    }
  };
  trackChild(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.stdin.on("error", () => undefined);
  child.on("error", (err: NodeJS.ErrnoException) =>
    settle(
      provider,
      session,
      "failed",
      err.code === "ENOENT" ? `${cliBinary(provider)} CLI가 설치되어 있지 않습니다.` : "로그인 명령을 실행하지 못했습니다.",
    ),
  );
  child.on("close", (code) => {
    if (logins.get(provider) !== session || ["succeeded", "failed", "cancelled"].includes(session.view.phase)) return;
    invalidateStatus(provider);
    if (code !== 0) {
      settle(
        provider,
        session,
        "failed",
        session.view.codeSubmitted
          ? "코드가 받아들여지지 않았습니다. 코드가 만료됐거나 잘렸을 수 있습니다. 로그인을 다시 시작해 주세요."
          : "로그인이 완료되지 않았습니다. 다시 시작해 주세요.",
      );
      return;
    }
    session.view = { ...session.view, phase: "verifying" };
    void getCliStatus(provider, { fresh: true }).then((s) =>
      settle(
        provider,
        session,
        s.loggedIn ? "succeeded" : "failed",
        s.loggedIn ? null : (s.error ?? "로그인은 끝났지만 연결을 확인하지 못했습니다. 다시 시도해 주세요."),
      ),
    );
  });

  // 안내문이 나올 때까지 잠깐 기다려 첫 응답에 링크를 담는다.
  for (let i = 0; i < 40 && session.view.phase === "starting"; i++) await new Promise((r) => setTimeout(r, 250));
  if (session.view.phase === "starting") {
    settle(provider, session, "failed", "로그인 안내를 받지 못했습니다. CLI 버전을 확인한 뒤 다시 시도해 주세요.");
  }
  return { ...session.view };
}

/** Claude 로그인: 브라우저에서 받은 코드를 CLI에 넘긴다. */
export function submitLoginCode(provider: CliProviderId, code: string): LoginView {
  assertManageable(provider);
  const session = logins.get(provider);
  if (!session || session.view.phase !== "waiting") {
    throw new ProviderServiceError("진행 중인 로그인이 없습니다. 로그인을 다시 시작해 주세요.", 409);
  }
  if (!session.view.needsCode) throw new ProviderServiceError("이 로그인은 코드를 붙여넣지 않습니다.", 400);
  if (session.view.codeSubmitted) throw new ProviderServiceError("이미 코드를 보냈습니다. 결과를 기다려 주세요.", 409);
  const trimmed = code.trim();
  if (!/^[A-Za-z0-9_\-#.~]{8,2048}$/.test(trimmed)) {
    throw new ProviderServiceError("코드 형식이 올바르지 않습니다. 로그인 페이지에 표시된 코드를 그대로 붙여넣어 주세요.", 400);
  }
  session.child.stdin.write(`${trimmed}\n`);
  session.view = { ...session.view, phase: "verifying", codeSubmitted: true };
  return { ...session.view };
}

export function cancelLogin(provider: CliProviderId): void {
  const session = logins.get(provider);
  if (session) settle(provider, session, "cancelled", "로그인을 취소했습니다.");
}

/** 앱 전용 홈의 로그인을 지운다(이 PC의 개인 CLI 로그인은 건드리지 않는다). */
export async function logout(provider: CliProviderId): Promise<void> {
  assertManageable(provider);
  cancelLogin(provider);
  const args = provider === "claude-cli" ? ["auth", "logout"] : ["logout"];
  try {
    await runCli(provider, args, { timeoutMs: STATUS_TIMEOUT_MS });
  } finally {
    invalidateStatus(provider);
  }
}
