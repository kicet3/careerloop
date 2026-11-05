import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const g = await import("./google");

const CID = "cid.apps.googleusercontent.com";
const NOW = 1_800_000_000_000;

function jwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "RS256" })}.${b(payload)}.sig`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CID,
  azp: CID,
  sub: "1234567890",
  email: "User@Gmail.com",
  email_verified: true,
  name: "홍길동",
  nonce: "n-1",
  iat: NOW / 1000 - 10,
  exp: NOW / 1000 + 3600,
  ...over,
});

describe("validateIdTokenClaims", () => {
  const opts = { clientId: CID, nonce: "n-1", now: NOW };

  it("올바른 클레임이면 sub·소문자 이메일·이름을 돌려준다", () => {
    expect(g.validateIdTokenClaims(claims(), opts)).toEqual({ sub: "1234567890", email: "user@gmail.com", name: "홍길동" });
    expect(g.validateIdTokenClaims(claims({ iss: "accounts.google.com", name: undefined }), opts).name).toBeNull();
    expect(g.validateIdTokenClaims(claims({ aud: [CID] }), opts).sub).toBe("1234567890");
    expect(g.validateIdTokenClaims(claims({ email: "a@corp.com", hd: "Corp.com" }), opts).hd).toBe("corp.com");
  });

  it.each([
    ["iss", { iss: "https://evil.example.com" }],
    ["aud", { aud: "other-client" }],
    ["aud 배열", { aud: ["other-client"] }],
    ["azp", { aud: [CID, "x"], azp: "x" }],
    ["exp 지남", { exp: NOW / 1000 - 120 }],
    ["exp 없음", { exp: undefined }],
    ["iat 미래", { iat: NOW / 1000 + 3600 }],
    ["nonce", { nonce: "n-2" }],
    ["nonce 없음", { nonce: undefined }],
    ["sub", { sub: "" }],
  ])("%s가 틀리면 google_failed", (_, over) => {
    try {
      g.validateIdTokenClaims(claims(over), opts);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(g.GoogleAuthError);
      expect((e as InstanceType<typeof g.GoogleAuthError>).code).toBe("google_failed");
    }
  });

  it.each([
    ["미인증", { email_verified: false }],
    ["문자열 true", { email_verified: "true" }],
    ["이메일 없음", { email: undefined }],
  ])("이메일 %s이면 google_email", (_, over) => {
    expect(() => g.validateIdTokenClaims(claims(over), opts)).toThrow(/이메일/);
  });

  it("형식이 틀린 JWT는 거절", () => {
    expect(g.decodeJwtPayload("a.b")).toBeNull();
    expect(g.decodeJwtPayload("a.!!!.c")).toBeNull();
    expect(() => g.validateIdTokenClaims(g.decodeJwtPayload("x"), opts)).toThrow(g.GoogleAuthError);
    expect(g.decodeJwtPayload(jwt({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("OAuth state 쿠키", () => {
  const SECRET = "client-secret";
  const s = g.newOAuthState({ next: "/app/diagnoses?x=1", redirectUri: "http://localhost:3000/api/auth/google/callback" }, NOW);

  it("서명한 값을 그대로 되읽는다", () => {
    const raw = g.encodeOAuthCookie(s, SECRET);
    expect(g.decodeOAuthCookie(raw, SECRET, NOW + 1000)).toEqual(s);
    expect(s.verifier.length).toBeGreaterThanOrEqual(43);
    expect(s.state).not.toBe(s.nonce);
  });

  it("변조·다른 키·만료·형식 오류는 null", () => {
    const raw = g.encodeOAuthCookie(s, SECRET);
    const [payload, sig] = raw.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, next: "/evil" })).toString("base64url");
    expect(g.decodeOAuthCookie(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    // 첫 글자를 반드시 다른 글자로 바꾼다(원래 첫 글자가 'x'면 변조가 아니게 되어 가끔 실패했다).
    const flipped = (sig![0] === "x" ? "y" : "x") + sig!.slice(1);
    expect(g.decodeOAuthCookie(`${payload}.${flipped}`, SECRET, NOW)).toBeNull();
    expect(g.decodeOAuthCookie(raw, "other", NOW)).toBeNull();
    expect(g.decodeOAuthCookie(raw, SECRET, NOW + g.OAUTH_TTL_MS + 1)).toBeNull();
    expect(g.decodeOAuthCookie(undefined, SECRET, NOW)).toBeNull();
    expect(g.decodeOAuthCookie("nodot", SECRET, NOW)).toBeNull();
  });

  it("next는 안전한 경로만 남긴다", () => {
    expect(g.newOAuthState({ next: "//evil.com", redirectUri: "x" }).next).toBe("/app");
    expect(g.newOAuthState({ next: "/login", redirectUri: "x" }).next).toBe("/app");
  });

  it("safeEqual", () => {
    expect(g.safeEqual("abc", "abc")).toBe(true);
    expect(g.safeEqual("abc", "abd")).toBe(false);
    expect(g.safeEqual("abc", "abcd")).toBe(false);
  });

  it("인가 URL에 PKCE S256·nonce·state·prompt를 담는다", () => {
    const url = new URL(g.buildAuthorizationUrl({ clientId: CID, clientSecret: SECRET }, s));
    expect(url.origin + url.pathname).toBe(g.GOOGLE_AUTH_ENDPOINT);
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      client_id: CID,
      redirect_uri: s.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: s.state,
      nonce: s.nonce,
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    // RFC 7636 부록 B 예시
    expect(g.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(q.code_challenge).toBe(g.pkceChallenge(s.verifier));
  });
});

describe("resolveRedirectUri", () => {
  const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
  const CB = "/api/auth/google/callback";

  it("PRODUCTION은 APP_URL만 쓰고 Host 헤더를 무시한다", () => {
    const env = { APP_ENV: "PRODUCTION", APP_URL: "https://resume.example.com/" };
    expect(g.resolveRedirectUri(req("http://internal:3000/api/auth/google", { host: "evil.com" }), env)).toBe(
      `https://resume.example.com${CB}`,
    );
    expect(g.resolveRedirectUri(req("http://x/"), { APP_ENV: "PRODUCTION", APP_URL: "http://resume.example.com" })).toBeNull();
    expect(g.resolveRedirectUri(req("http://x/"), { APP_ENV: "PRODUCTION", GOOGLE_REDIRECT_ORIGIN: "https://a.ts.net" })).toBeNull();
  });

  it("DEV: GOOGLE_REDIRECT_ORIGIN → APP_URL → 요청 origin", () => {
    const r = req("http://localhost:3000/api/auth/google");
    expect(g.resolveRedirectUri(r, { GOOGLE_REDIRECT_ORIGIN: "https://m.tail.ts.net:9470", APP_URL: "https://a.com" })).toBe(
      `https://m.tail.ts.net:9470${CB}`,
    );
    expect(g.resolveRedirectUri(r, { APP_URL: "http://localhost:3001" })).toBe(`http://localhost:3001${CB}`);
    expect(g.resolveRedirectUri(r, {})).toBe(`http://localhost:3000${CB}`);
  });

  it("DEV 요청 origin: 프록시 헤더를 따르고 허용 호스트만", () => {
    const viaServe = req("http://127.0.0.1:3000/api/auth/google", {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "dev-machine.example-tailnet.ts.net:9470",
      "x-forwarded-proto": "https",
    });
    expect(g.resolveRedirectUri(viaServe, {})).toBe(`https://dev-machine.example-tailnet.ts.net:9470${CB}`);
    expect(g.resolveRedirectUri(req("http://evil.com/api/auth/google", { host: "evil.com" }), {})).toBeNull();
    const ip = req("http://100.101.102.103:3000/api/auth/google", { host: "100.101.102.103:3000" });
    expect(g.resolveRedirectUri(ip, {})).toBeNull();
    expect(g.resolveRedirectUri(ip, { DEV_ALLOWED_ORIGINS: "100.101.102.103" })).toBe(`http://100.101.102.103:3000${CB}`);
    expect(g.resolveRedirectUri(req("http://localhost:3000/", { "x-forwarded-proto": "javascript" }), {})).toBeNull();
  });
});

describe("exchangeCodeForClaims", () => {
  const cfg = { clientId: CID, clientSecret: "sec" };
  const state = { ...g.newOAuthState({ next: "/app", redirectUri: "http://localhost:3000/api/auth/google/callback" }), nonce: "n-1" };

  it("code_verifier·redirect_uri를 보내고 id_token을 검증한다", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code")).toBe("abc");
      expect(body.get("code_verifier")).toBe(state.verifier);
      expect(body.get("redirect_uri")).toBe(state.redirectUri);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ id_token: jwt(claims()), access_token: "at" });
    });
    const out = await g.exchangeCodeForClaims(cfg, { code: "abc", state }, { fetch: fetchMock as typeof fetch, now: NOW });
    expect(out.email).toBe("user@gmail.com");
    expect(fetchMock).toHaveBeenCalledWith(g.GOOGLE_TOKEN_ENDPOINT, expect.anything());
  });

  it("토큰 오류·네트워크 오류는 google_failed", async () => {
    const bad = (async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
    await expect(g.exchangeCodeForClaims(cfg, { code: "x", state }, { fetch: bad, now: NOW })).rejects.toMatchObject({
      code: "google_failed",
    });
    const down = (async () => {
      throw new Error("timeout");
    }) as typeof fetch;
    await expect(g.exchangeCodeForClaims(cfg, { code: "x", state }, { fetch: down, now: NOW })).rejects.toBeInstanceOf(
      g.GoogleAuthError,
    );
  });
});

describe("authErrorMessage", () => {
  it("아는 코드만 문구로 바꾼다", () => {
    expect(g.authErrorMessage("access_denied")).toMatch(/취소/);
    expect(g.authErrorMessage("<script>")).toBeNull();
    expect(g.authErrorMessage("toString")).toBeNull();
    expect(g.authErrorMessage(["access_denied"])).toBeNull();
  });
});
