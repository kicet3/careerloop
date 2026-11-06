import { describe, expect, it, vi } from "vitest";
import { resolveCallbackUri, resolveRedirectUri } from "@/lib/auth/google";
import {
  buildGithubAuthorizeUrl,
  decodeGithubOAuthCookie,
  encodeGithubOAuthCookie,
  exchangeGithubCode,
  fetchGithubUser,
  GITHUB_CALLBACK_PATH,
  githubConfig,
  newGithubOAuthState,
  refreshGithubToken,
  revokeGithubGrantRequest,
} from "./oauth";
import { pkceChallenge } from "@/lib/auth/google";
import { withGithubParam } from "./redirect";
import { GithubApiError, GithubAuthError, githubErrorMessage, parseFullName } from "./types";
import { FAKE_GITHUB_ENV } from "@/test/fake-github";

vi.mock("server-only", () => ({}));

const cfg = { clientId: "Iv1.abc", clientSecret: "shh" };
const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers: new Headers(headers) });

describe("GitHub OAuth 쿠키·PKCE", () => {
  it("서명 쿠키 왕복, 사용자 id를 담는다", () => {
    const s = newGithubOAuthState({ next: "/app/graph?github=pick", redirectUri: "http://localhost:3000/api/github/callback", userId: "u1" }, 1000);
    const raw = encodeGithubOAuthCookie(s, "shh");
    const back = decodeGithubOAuthCookie(raw, "shh", 2000);
    expect(back).toEqual(s);
    expect(back!.userId).toBe("u1");
    expect(back!.next).toBe("/app/graph?github=pick");
  });

  it("다른 비밀·만료·변조·너무 큰 쿠키는 null", () => {
    const s = newGithubOAuthState({ next: "/app", redirectUri: "x", userId: "u1" }, 1000);
    const raw = encodeGithubOAuthCookie(s, "shh");
    expect(decodeGithubOAuthCookie(raw, "other", 2000)).toBeNull();
    expect(decodeGithubOAuthCookie(raw, "shh", s.exp + 1)).toBeNull();
    const [payload, sig] = raw.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, userId: "attacker" })).toString("base64url");
    expect(decodeGithubOAuthCookie(`${forged}.${sig}`, "shh", 2000)).toBeNull();
    expect(decodeGithubOAuthCookie(`${payload}.${"x".repeat(5000)}`, "shh", 2000)).toBeNull();
  });

  it("외부 주소 next는 기본 경로로", () => {
    const s = newGithubOAuthState({ next: "https://evil.example", redirectUri: "x", userId: "u1" });
    expect(s.next).toBe("/app");
  });

  it("인가 주소: client_id·redirect_uri·state·S256 challenge·allow_signup=false", () => {
    const s = newGithubOAuthState({ next: "/app", redirectUri: "https://resume.snowlink.team/api/github/callback", userId: "u1" });
    const url = new URL(buildGithubAuthorizeUrl(cfg, s));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("redirect_uri")).toBe(s.redirectUri);
    expect(url.searchParams.get("state")).toBe(s.state);
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(s.verifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("allow_signup")).toBe("false");
  });
});

describe("GitHub 토큰 교환·갱신", () => {
  const state = newGithubOAuthState({ next: "/app", redirectUri: "http://localhost:3000/api/github/callback", userId: "u1" });

  it("코드 교환: verifier·redirect_uri를 보내고 만료 시각을 계산한다", async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("code_verifier")).toBe(state.verifier);
      expect(form.get("redirect_uri")).toBe(state.redirectUri);
      expect(form.get("client_secret")).toBe("shh");
      return Response.json({ access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 100 });
    });
    const t = await exchangeGithubCode(cfg, { code: "c", state }, { fetch: fetchMock as typeof fetch, now: 0 });
    expect(t).toEqual({ accessToken: "ghu_1", accessTokenExpiresAt: new Date(28_800_000), refreshToken: "ghr_1", refreshTokenExpiresAt: new Date(100_000) });
  });

  it("200인데 error가 오면·JSON이 아니면·시간 초과면 실패", async () => {
    const withError = async () => Response.json({ error: "bad_verification_code" });
    await expect(exchangeGithubCode(cfg, { code: "c", state }, { fetch: withError as typeof fetch })).rejects.toBeInstanceOf(GithubApiError);
    const notJson = async () => new Response("<html>", { status: 200 });
    await expect(exchangeGithubCode(cfg, { code: "c", state }, { fetch: notJson as typeof fetch })).rejects.toBeInstanceOf(GithubApiError);
    const timeout = async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    };
    await expect(exchangeGithubCode(cfg, { code: "c", state }, { fetch: timeout as typeof fetch })).rejects.toBeInstanceOf(GithubApiError);
  });

  it("갱신이 거절되면 GithubAuthError(다시 연결), 일시 장애·설정 오류는 GithubApiError(토큰을 지우지 않는다)", async () => {
    const rejected = async () => Response.json({ error: "bad_refresh_token" });
    await expect(refreshGithubToken(cfg, "ghr_x", { fetch: rejected as typeof fetch })).rejects.toBeInstanceOf(GithubAuthError);
    const down = async () => new Response("<html>", { status: 503 });
    await expect(refreshGithubToken(cfg, "ghr_x", { fetch: down as typeof fetch })).rejects.toBeInstanceOf(GithubApiError);
    const badCreds = async () => Response.json({ error: "incorrect_client_credentials" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(refreshGithubToken(cfg, "ghr_x", { fetch: badCreds as typeof fetch })).rejects.toBeInstanceOf(GithubApiError);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    const timeout = async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    };
    await expect(refreshGithubToken(cfg, "ghr_x", { fetch: timeout as typeof fetch })).rejects.toBeInstanceOf(GithubApiError);
  });

  it("GET /user: 401 → GithubAuthError, 아바타는 githubusercontent만", async () => {
    await expect(fetchGithubUser("t", { fetch: (async () => new Response(null, { status: 401 })) as typeof fetch })).rejects.toBeInstanceOf(GithubAuthError);
    const u = await fetchGithubUser("t", {
      fetch: (async () => Response.json({ id: 5, login: "me", avatar_url: "https://evil.example/x.png" })) as typeof fetch,
    });
    expect(u).toEqual({ id: "5", login: "me", avatarUrl: null });
  });

  it("권한 해지: Basic client_id:client_secret, 본문 access_token, 실패해도 던지지 않는다", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.github.com/applications/Iv1.abc/grant");
      expect(init?.method).toBe("DELETE");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("Iv1.abc:shh").toString("base64")}`);
      expect(JSON.parse(String(init?.body))).toEqual({ access_token: "ghu_1" });
      return new Response(null, { status: 204 });
    });
    expect(await revokeGithubGrantRequest(cfg, "ghu_1", { fetch: fetchMock as typeof fetch })).toBe(true);
    const failing = async () => {
      throw new Error("down");
    };
    expect(await revokeGithubGrantRequest(cfg, "ghu_1", { fetch: failing as typeof fetch })).toBe(false);
  });
});

describe("설정·redirect_uri·결과 주소", () => {
  it("githubConfig: 모두 있어야 한다, slug는 선택", () => {
    expect(githubConfig({})).toBeNull();
    const c = githubConfig(FAKE_GITHUB_ENV);
    expect(c?.clientId).toBe(FAKE_GITHUB_ENV.GITHUB_APP_CLIENT_ID);
    expect(c?.slug).toBe("careerloop-test");
    expect(c?.encKey.length).toBe(32);
  });

  it("PRODUCTION은 APP_URL https만, DEV는 GITHUB_REDIRECT_ORIGIN → APP_URL → 허용된 요청 origin", () => {
    const opts = { path: GITHUB_CALLBACK_PATH, originEnvKey: "GITHUB_REDIRECT_ORIGIN" };
    const prod = { APP_ENV: "PRODUCTION", APP_URL: "https://resume.snowlink.team" };
    expect(resolveCallbackUri(req("https://evil.example/x", { host: "evil.example" }), prod, opts)).toBe("https://resume.snowlink.team/api/github/callback");
    expect(resolveCallbackUri(req("http://x/"), { APP_ENV: "PRODUCTION", APP_URL: "http://insecure" }, opts)).toBeNull();
    expect(resolveCallbackUri(req("http://localhost:3000/x"), { GITHUB_REDIRECT_ORIGIN: "https://dev.ts.net:9470" }, opts)).toBe(
      "https://dev.ts.net:9470/api/github/callback",
    );
    expect(resolveCallbackUri(req("http://localhost:3000/x", { host: "localhost:3000" }), {}, opts)).toBe("http://localhost:3000/api/github/callback");
    expect(resolveCallbackUri(req("http://evil.example/x", { host: "evil.example" }), {}, opts)).toBeNull();
    // Google은 그대로
    expect(resolveRedirectUri(req("http://localhost:3000/x", { host: "localhost:3000" }), {})).toBe("http://localhost:3000/api/auth/google/callback");
  });

  it("withGithubParam: 성공은 github=connected(이미 github가 있으면 유지), 실패는 github_error", () => {
    expect(withGithubParam("/app/account#github", { connected: true })).toBe("/app/account?github=connected#github");
    expect(withGithubParam("/app/graph?github=pick", { connected: true })).toBe("/app/graph?github=pick");
    expect(withGithubParam("/app/graph?github=pick", { error: "access_denied" })).toBe("/app/graph?github_error=access_denied");
  });

  it("오류 코드는 정해 둔 것만 문구로, owner/repo 검사", () => {
    expect(githubErrorMessage("github_conflict")).toMatch(/다른 CareerLoop 계정/);
    expect(githubErrorMessage("<script>")).toBeNull();
    expect(parseFullName("octo/career-app")).toEqual({ owner: "octo", repo: "career-app" });
    expect(parseFullName("https://github.com/octo/career-app.git")).toEqual({ owner: "octo", repo: "career-app" });
    expect(parseFullName("octo/../x")).toBeNull();
    expect(parseFullName("-bad/x")).toBeNull();
    expect(parseFullName("octo/..")).toBeNull();
    expect(parseFullName("a/b/c")).toBeNull();
  });
});
