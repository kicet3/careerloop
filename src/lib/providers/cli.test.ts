import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { cliEnv, cliProvidersEnabled } = await import("./cli");

describe("cliProvidersEnabled", () => {
  it("CLI_PROVIDERS=1일 때만 켠다(DEV)", () => {
    expect(cliProvidersEnabled({})).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "0" })).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1" })).toBe(true);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1", APP_ENV: "DEV" })).toBe(true);
  });

  it("PRODUCTION은 CLI_PROVIDERS_IN_PRODUCTION=1까지 있어야 켠다", () => {
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1", APP_ENV: "PRODUCTION" })).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS_IN_PRODUCTION: "1", APP_ENV: "PRODUCTION" })).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1", CLI_PROVIDERS_IN_PRODUCTION: "1", APP_ENV: "PRODUCTION" })).toBe(true);
  });
});

describe("cliEnv: 허용 목록 환경", () => {
  afterEach(() => vi.unstubAllEnvs());

  const SERVER_ENV = {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/app",
    USER: "app",
    LANG: "ko_KR.UTF-8",
    LC_ALL: "ko_KR.UTF-8",
    TMPDIR: "/tmp/x",
    TERM: "xterm",
    HTTPS_PROXY: "http://proxy:3128",
    no_proxy: "localhost",
    // 넘기면 안 되는 것
    DATABASE_URL: "postgres://u:p@db/x",
    DIRECT_URL: "postgres://u:p@db/x",
    POSTGRES_PRISMA_URL: "postgres://u:p@db/x",
    NEO4J_PASSWORD: "neo",
    NEO4J_URI: "neo4j+s://x",
    ANTHROPIC_API_KEY: "sk-ant-x",
    OPENAI_API_KEY: "sk-x",
    GOOGLE_CLIENT_SECRET: "g",
    GITHUB_APP_CLIENT_SECRET: "gh",
    GITHUB_APP_PRIVATE_KEY: "pem",
    GITHUB_TOKEN_ENC_KEY: "k",
    R2_ACCESS_KEY_ID: "r2",
    R2_SECRET_ACCESS_KEY: "r2s",
    SESSION_SECRET: "s",
    CRON_SECRET: "c",
    MCP_TOKEN_SECRET: "m",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDECODE: "1",
    CLAUDE_CONFIG_DIR: "/home/app/.claude-personal",
    CODEX_HOME: "/home/app/.codex-personal",
    NODE_OPTIONS: "--require /tmp/evil.js",
    VERCEL: "",
  };

  it("필요한 변수만 넘기고 비밀처럼 보이는 변수는 하나도 넘기지 않는다", () => {
    vi.stubEnv("CLAUDE_CLI_CONFIG_DIR", "system");
    const env = cliEnv("claude-cli", {}, SERVER_ENV);
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/app",
      USER: "app",
      LANG: "ko_KR.UTF-8",
      LC_ALL: "ko_KR.UTF-8",
      TMPDIR: "/tmp/x",
      TERM: "xterm",
      HTTPS_PROXY: "http://proxy:3128",
      no_proxy: "localhost",
      NO_COLOR: "1",
      BROWSER: process.platform === "win32" ? "echo" : "true",
    });
    for (const k of Object.keys(env)) expect(k).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY|DATABASE|POSTGRES|NEO4J|R2_|ANTHROPIC|OPENAI/i);
  });

  it("전용 홈을 쓰면 엔진별 설정 폴더 변수만 앱이 지정한다(부모 값은 쓰지 않는다)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli-env-test-"));
    vi.stubEnv("CLAUDE_CLI_CONFIG_DIR", path.join(dir, "claude"));
    vi.stubEnv("CODEX_CLI_HOME", path.join(dir, "codex"));
    const claude = cliEnv("claude-cli", {}, SERVER_ENV);
    expect(claude.CLAUDE_CONFIG_DIR).toBe(path.join(dir, "claude"));
    expect(claude.CODEX_HOME).toBeUndefined();
    const codex = cliEnv("codex-cli", {}, SERVER_ENV);
    expect(codex.CODEX_HOME).toBe(path.join(dir, "codex"));
    expect(codex.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(codex.DATABASE_URL).toBeUndefined();
  });

  it("기본값은 process.env에서 읽는다", () => {
    vi.stubEnv("CLAUDE_CLI_CONFIG_DIR", "system");
    vi.stubEnv("NEO4J_PASSWORD", "leak");
    vi.stubEnv("PATH", "/bin");
    const env = cliEnv("claude-cli");
    expect(env.NEO4J_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
