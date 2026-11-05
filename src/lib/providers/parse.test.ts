import { describe, expect, it } from "vitest";
import {
  looksLikeAuthError,
  looksLikeTransientOverload,
  looksLikeUsageLimit,
  parseClaudeAuthStatus,
  parseClaudeLoginPrompt,
  parseCodexDevicePrompt,
  parseCodexLoginStatus,
} from "./parse";

const ESC = "\x1b";
const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=xyz&code_challenge_method=S256&state=st";

describe("parseClaudeLoginPrompt", () => {
  it("OSC 8 하이퍼링크로 감싼 인가 링크를 뽑는다", () => {
    const out = `Opening browser to sign in…\nIf the browser didn't open, visit: ${ESC}]8;;${AUTH_URL}${ESC}\\${AUTH_URL}${ESC}]8;;${ESC}\\\nPaste code here if prompted > `;
    expect(parseClaudeLoginPrompt(out)).toEqual({ url: AUTH_URL });
  });

  it("허용하지 않은 호스트·경로의 링크는 무시한다", () => {
    expect(parseClaudeLoginPrompt("visit: https://evil.example.com/oauth/authorize?x=1")).toBeNull();
    expect(parseClaudeLoginPrompt("visit: https://claude.com/download")).toBeNull();
    expect(parseClaudeLoginPrompt("Opening browser to sign in…")).toBeNull();
  });
});

describe("parseCodexDevicePrompt", () => {
  const out = [
    "Welcome to Codex [v\x1b[90m0.162.1\x1b[0m]",
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "",
    "1. Open this link in your browser and sign in to your account",
    "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m",
    "",
    "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m",
    "   \x1b[94mAB12-CD34E\x1b[0m",
    "",
  ].join("\n");

  it("기기 인증 링크와 1회용 코드를 뽑는다", () => {
    expect(parseCodexDevicePrompt(out)).toEqual({ url: "https://auth.openai.com/codex/device", code: "AB12-CD34E" });
  });

  it("코드가 아직 안 나왔으면 null", () => {
    expect(parseCodexDevicePrompt(out.split("2. Enter")[0]!)).toBeNull();
  });

  it("다른 링크는 받지 않는다", () => {
    expect(parseCodexDevicePrompt(out.replace("auth.openai.com/codex/device", "auth.openai.com.evil.io/codex/device"))).toBeNull();
  });
});

describe("상태 출력", () => {
  it("claude auth status JSON", () => {
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c"}')).toEqual({
      parsed: true,
      loggedIn: true,
      account: "a@b.c",
      method: "claude.ai",
    });
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}').loggedIn).toBe(false);
    expect(parseClaudeAuthStatus("not json")).toMatchObject({ parsed: false, loggedIn: false });
  });

  it("codex login status", () => {
    expect(parseCodexLoginStatus("Logged in using ChatGPT\n")).toEqual({ recognized: true, loggedIn: true, account: "ChatGPT" });
    expect(parseCodexLoginStatus("Not logged in\n")).toEqual({ recognized: true, loggedIn: false, account: null });
    expect(parseCodexLoginStatus("error: config parse failed")).toMatchObject({ recognized: false, loggedIn: false });
  });
});

describe("오류 분류", () => {
  it("로그인 문제", () => {
    expect(looksLikeAuthError("Not logged in · Please run /login")).toBe(true);
    expect(looksLikeAuthError("unexpected status 401 Unauthorized: Missing bearer")).toBe(true);
    expect(looksLikeAuthError("OAuth token has expired")).toBe(true);
    expect(looksLikeAuthError("schema mismatch")).toBe(false);
  });

  it("구독 사용량 한도와 일시적 과부하를 구분한다", () => {
    expect(looksLikeUsageLimit("You've hit your limit · resets 5pm")).toBe(true);
    expect(looksLikeUsageLimit("Overloaded")).toBe(false);
    expect(looksLikeTransientOverload("API Error: 529 Overloaded")).toBe(true);
    expect(looksLikeTransientOverload("API Error: 429 rate_limit_error")).toBe(true);
    expect(looksLikeTransientOverload("JSON parse error")).toBe(false);
  });
});
