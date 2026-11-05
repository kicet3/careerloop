import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { googleLoginConfigured, httpsAppUrlHost, isProduction } from "@/lib/config/env";
import { safeNextPath } from "./validation";

/**
 * Google 로그인(OpenID Connect 인가 코드 흐름 + PKCE). 외부 라이브러리 없이 구현한다.
 * 이 파일은 순수 함수만 둔다(쿠키·DB 접근은 라우트와 google-user.ts). 모든 함수는 테스트를 위해 env·now·fetch를 인자로 받는다.
 */

type Env = Record<string, string | undefined>;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";

/** 시작~콜백 사이의 state·PKCE·nonce를 담는 쿠키. 콜백 경로에만 보낸다. */
export const OAUTH_COOKIE = "rp_google_oauth";
export const OAUTH_COOKIE_PATH = "/api/auth/google";
export const OAUTH_TTL_MS = 10 * 60_000;
/** id_token exp·iat 비교에 허용할 시계 오차. */
const CLOCK_SKEW_MS = 60_000;
const TOKEN_TIMEOUT_MS = 10_000;

export type GoogleConfig = { clientId: string; clientSecret: string };

export function googleConfig(env: Env = process.env): GoogleConfig | null {
  if (!googleLoginConfigured(env)) return null;
  return { clientId: env.GOOGLE_CLIENT_ID!.trim(), clientSecret: env.GOOGLE_CLIENT_SECRET!.trim() };
}

// ---------------------------------------------------------------------------
// redirect_uri

/** 개발 서버로 허용하는 호스트 이름(next.config의 allowedDevOrigins와 같은 규칙: localhost·*.ts.net·DEV_ALLOWED_ORIGINS). */
function devHostAllowed(hostname: string, env: Env): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".ts.net")) return true;
  const extra = (env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(h);
}

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

type HeaderReq = { url: string; headers: { get(name: string): string | null } };

/** 브라우저가 실제로 연 주소의 origin(DEV 전용). 리버스 프록시(tailscale serve 등)의 X-Forwarded-*를 우선한다. */
function requestOrigin(req: HeaderReq): string | null {
  let fallback: URL | null = null;
  try {
    fallback = new URL(req.url);
  } catch {}
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]!.trim() || req.headers.get("host")?.trim() || fallback?.host;
  if (!host) return null;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]!.trim().toLowerCase() || fallback?.protocol.replace(/:$/, "") || "http";
  if (proto !== "http" && proto !== "https") return null;
  return originOf(`${proto}://${host}`);
}

/**
 * Google에 등록할 redirect_uri(`<origin>/api/auth/google/callback`). 못 정하면 null.
 * - PRODUCTION: APP_URL(https)만 쓴다. 요청의 Host 헤더는 믿지 않는다.
 * - DEV: GOOGLE_REDIRECT_ORIGIN → APP_URL → 요청 origin 순. 요청 origin은 localhost·*.ts.net·DEV_ALLOWED_ORIGINS 호스트만 허용.
 *   (예: Tailscale https 주소로 고정하려면 GOOGLE_REDIRECT_ORIGIN=https://<기기>.<tailnet>.ts.net:9470)
 */
export function resolveRedirectUri(req: HeaderReq, env: Env = process.env): string | null {
  if (isProduction(env)) {
    const host = httpsAppUrlHost(env);
    return host ? `https://${host}${GOOGLE_CALLBACK_PATH}` : null;
  }
  const configured = originOf(env.GOOGLE_REDIRECT_ORIGIN) ?? originOf(env.APP_URL);
  if (configured) return configured + GOOGLE_CALLBACK_PATH;
  const origin = requestOrigin(req);
  if (!origin || !devHostAllowed(new URL(origin).hostname, env)) return null;
  return origin + GOOGLE_CALLBACK_PATH;
}

// ---------------------------------------------------------------------------
// state·PKCE·nonce 쿠키

export type OAuthState = {
  state: string;
  verifier: string;
  nonce: string;
  next: string;
  redirectUri: string;
  /** 만료 시각(ms) */
  exp: number;
};

const rand = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function newOAuthState(input: { next: unknown; redirectUri: string }, now: number = Date.now()): OAuthState {
  return {
    state: rand(),
    verifier: rand(48), // 64자(43~128자 범위)
    nonce: rand(),
    next: safeNextPath(input.next),
    redirectUri: input.redirectUri,
    exp: now + OAUTH_TTL_MS,
  };
}

/** 쿠키 서명 키. 별도 비밀 설정 없이 클라이언트 비밀에서 파생한다(용도 구분 문자열 포함). */
function cookieKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("rp-google-oauth-cookie-v1").digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", cookieKey(secret)).update(payload).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // 길이가 달라도 비교 시간을 일정하게 하려고 같은 길이 버퍼끼리 한 번 비교한다.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** `<base64url(JSON)>.<HMAC>` */
export function encodeOAuthCookie(s: OAuthState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** 서명·형식·만료를 확인한다. 하나라도 어긋나면 null. */
export function decodeOAuthCookie(raw: string | undefined, secret: string, now: number = Date.now()): OAuthState | null {
  if (!raw || raw.length > 4096) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  if (!safeEqual(raw.slice(dot + 1), sign(payload, secret))) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const o = v as Partial<OAuthState>;
  for (const k of ["state", "verifier", "nonce", "next", "redirectUri"] as const) if (typeof o?.[k] !== "string") return null;
  if (typeof o.exp !== "number" || o.exp <= now) return null;
  return { ...(o as OAuthState), next: safeNextPath(o.next) };
}

export function buildAuthorizationUrl(cfg: GoogleConfig, s: OAuthState): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: s.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: s.state,
    nonce: s.nonce,
    code_challenge: pkceChallenge(s.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

// ---------------------------------------------------------------------------
// 토큰 교환·id_token 검증

export class GoogleAuthError extends Error {
  constructor(
    /** /login?error= 로 넘길 코드 */
    readonly code: "google_failed" | "google_email",
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/** hd: Google Workspace 계정의 도메인(id_token의 hd). 일반 계정이면 없다. */
export type GoogleClaims = { sub: string; email: string; name: string | null; hd?: string };

/** JWT payload(서명 검증 없이). 형식이 틀리면 null. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * id_token 클레임 검증. 토큰 엔드포인트에서 TLS로 직접 받은 토큰이므로 서명 검증은 생략한다(OIDC Core 3.1.3.7 6항).
 * iss·aud(·azp)·exp·iat·nonce·sub·email·email_verified를 확인한다.
 */
export function validateIdTokenClaims(
  payload: Record<string, unknown> | null,
  opts: { clientId: string; nonce: string; now?: number },
): GoogleClaims {
  const fail = (m: string) => new GoogleAuthError("google_failed", `id_token 검증 실패: ${m}`);
  if (!payload) throw fail("형식");
  const now = opts.now ?? Date.now();
  if (typeof payload.iss !== "string" || !(GOOGLE_ISSUERS as readonly string[]).includes(payload.iss)) throw fail("iss");
  const aud = payload.aud;
  if (typeof aud === "string") {
    if (aud !== opts.clientId) throw fail("aud");
  } else if (Array.isArray(aud)) {
    if (!aud.includes(opts.clientId)) throw fail("aud");
    if (aud.length > 1 && payload.azp !== opts.clientId) throw fail("azp");
  } else throw fail("aud");
  if (payload.azp !== undefined && payload.azp !== opts.clientId) throw fail("azp");
  if (typeof payload.exp !== "number" || payload.exp * 1000 + CLOCK_SKEW_MS <= now) throw fail("exp");
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat * 1000 - CLOCK_SKEW_MS > now)) throw fail("iat");
  if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, opts.nonce)) throw fail("nonce");
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) throw fail("sub");
  if (typeof payload.email !== "string" || !payload.email.includes("@") || payload.email.length > 254) {
    throw new GoogleAuthError("google_email", "Google 계정 이메일을 받지 못했습니다.");
  }
  if (payload.email_verified !== true) throw new GoogleAuthError("google_email", "Google에서 이메일 인증이 확인되지 않았습니다.");
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 50) : null;
  const hd = typeof payload.hd === "string" && payload.hd.trim() ? payload.hd.trim().toLowerCase() : undefined;
  return { sub: payload.sub, email: payload.email.trim().toLowerCase(), name, ...(hd ? { hd } : {}) };
}

/** 인가 코드를 토큰으로 바꾸고 id_token 클레임을 검증해 돌려준다. */
export async function exchangeCodeForClaims(
  cfg: GoogleConfig,
  input: { code: string; state: OAuthState },
  deps: { fetch?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<GoogleClaims> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: input.state.redirectUri,
        code_verifier: input.state.verifier,
      }).toString(),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new GoogleAuthError("google_failed", `토큰 요청 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
  if (!res.ok || typeof json?.id_token !== "string") {
    throw new GoogleAuthError("google_failed", `토큰 응답 오류(${res.status}${typeof json?.error === "string" ? ` ${json.error}` : ""})`);
  }
  return validateIdTokenClaims(decodeJwtPayload(json.id_token), {
    clientId: cfg.clientId,
    nonce: input.state.nonce,
    now: deps.now,
  });
}

// ---------------------------------------------------------------------------
// 오류 코드 → 로그인 화면 문구

export const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Google 로그인이 취소되었습니다.",
  google_state: "로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.",
  google_failed: "Google 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  google_email: "인증된 이메일이 있는 Google 계정만 사용할 수 있습니다.",
  google_conflict: "이 이메일은 다른 Google 계정과 이미 연결되어 있습니다.",
  google_link_unverified:
    "이 이메일로 가입된 계정이 있지만 Google이 이 주소의 소유를 보증하지 않아 연결할 수 없습니다. 이메일과 비밀번호로 로그인해 주세요.",
  google_unavailable: "Google 로그인이 설정되지 않았습니다. 관리자에게 문의해 주세요.",
  rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
};

/** ?error= 값을 화면 문구로. 모르는 값이면 null(임의 문자열을 그대로 보여 주지 않는다). */
export function authErrorMessage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return Object.hasOwn(GOOGLE_ERROR_MESSAGES, code) ? GOOGLE_ERROR_MESSAGES[code]! : null;
}
