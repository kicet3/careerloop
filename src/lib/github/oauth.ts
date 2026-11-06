/**
 * GitHub App 사용자 인가(user-to-server 토큰, 웹 흐름 + PKCE). 외부 라이브러리 없이 구현한다 — docs/GITHUB.md.
 * 이 파일은 순수 함수와 GitHub 호출만 둔다(쿠키·DB는 라우트와 account.ts). 모든 함수는 테스트를 위해 env·now·fetch를 인자로 받는다.
 *
 * GitHub App 사용자 토큰은 8시간 뒤 만료되고, 갱신 토큰(6개월, 쓸 때마다 새로 바뀜)으로 다시 받는다.
 * 권한은 앱에 준 것(Contents·Metadata 읽기)과 사용자가 앱을 설치한 저장소로 좁혀진다.
 */
import { createHmac, randomBytes } from "node:crypto";
import { decodeEncKey, githubConfigured, githubEncKey } from "@/lib/config/env-rules";
import { pkceChallenge, safeEqual } from "@/lib/auth/google";
import { safeNextPath } from "@/lib/auth/validation";
import { GithubApiError, GithubAuthError } from "./types";

type Env = Record<string, string | undefined>;
type Deps = { fetch?: typeof fetch; now?: number; timeoutMs?: number };

export const GITHUB_AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
export const GITHUB_API = "https://api.github.com";
export const GITHUB_CALLBACK_PATH = "/api/github/callback";
export const GITHUB_USER_AGENT = "CareerLoop (+https://resume.snowlink.team)";
export const GITHUB_API_VERSION = "2022-11-28";

/** 시작~콜백 사이의 state·PKCE를 담는 쿠키. /api/github 경로에만 보낸다. */
export const GITHUB_OAUTH_COOKIE = "rp_github_oauth";
export const GITHUB_OAUTH_COOKIE_PATH = "/api/github";
export const GITHUB_OAUTH_TTL_MS = 10 * 60_000;
const TOKEN_TIMEOUT_MS = 10_000;

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** GitHub App 이름(URL용). 있으면 '저장소 선택(설치)' 링크를 보인다. */
  slug: string | null;
  encKey: Buffer;
  encKeyPrevious: Buffer | null;
}

export function githubConfig(env: Env = process.env): GithubConfig | null {
  if (!githubConfigured(env)) return null;
  const slug = env.GITHUB_APP_SLUG?.trim();
  return {
    clientId: env.GITHUB_APP_CLIENT_ID!.trim(),
    clientSecret: env.GITHUB_APP_CLIENT_SECRET!.trim(),
    slug: slug && /^[a-z0-9-]{1,100}$/i.test(slug) ? slug : null,
    encKey: githubEncKey(env)!,
    encKeyPrevious: decodeEncKey(env.GITHUB_TOKEN_ENC_KEY_PREVIOUS),
  };
}

export function githubInstallUrl(cfg: Pick<GithubConfig, "slug"> | null): string | null {
  return cfg?.slug ? `https://github.com/apps/${cfg.slug}/installations/new` : null;
}

// ---------------------------------------------------------------------------
// state·PKCE 쿠키

export interface GithubOAuthState {
  state: string;
  verifier: string;
  next: string;
  redirectUri: string;
  /** 연결을 시작한 사용자(콜백의 세션 사용자와 같아야 한다 — 로그인 CSRF 방지). */
  userId: string;
  exp: number;
}

const rand = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function newGithubOAuthState(
  input: { next: unknown; redirectUri: string; userId: string },
  now: number = Date.now(),
): GithubOAuthState {
  return {
    state: rand(),
    verifier: rand(48),
    next: safeNextPath(input.next),
    redirectUri: input.redirectUri,
    userId: input.userId,
    exp: now + GITHUB_OAUTH_TTL_MS,
  };
}

function cookieKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("rp-github-oauth-cookie-v1").digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", cookieKey(secret)).update(payload).digest("base64url");
}

export function encodeGithubOAuthCookie(s: GithubOAuthState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeGithubOAuthCookie(raw: string | undefined, secret: string, now: number = Date.now()): GithubOAuthState | null {
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
  const o = v as Partial<GithubOAuthState>;
  for (const k of ["state", "verifier", "next", "redirectUri", "userId"] as const) if (typeof o?.[k] !== "string") return null;
  if (typeof o.exp !== "number" || o.exp <= now) return null;
  return { ...(o as GithubOAuthState), next: safeNextPath(o.next) };
}

export function buildGithubAuthorizeUrl(cfg: Pick<GithubConfig, "clientId">, s: GithubOAuthState): string {
  const url = new URL(GITHUB_AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: s.redirectUri,
    state: s.state,
    code_challenge: pkceChallenge(s.verifier),
    code_challenge_method: "S256",
    allow_signup: "false",
  }).toString();
  return url.toString();
}

// ---------------------------------------------------------------------------
// 토큰 교환·갱신

export interface GithubTokenSet {
  accessToken: string;
  /** 만료 없는 토큰(앱 설정에서 만료를 끈 경우)이면 null. */
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/** 갱신 토큰이 거절됐다는 뜻의 오류 코드(이때만 다시 연결을 요구한다). */
const REFRESH_REJECTED = new Set(["bad_refresh_token", "unauthorized", "invalid_grant"]);

/**
 * GitHub 토큰 엔드포인트의 실패: 코드 교환은 GithubApiError(github_failed).
 * 갱신은 GitHub이 갱신 토큰을 거절했을 때(bad_refresh_token 등)만 GithubAuthError(다시 연결) — 5xx·JSON 아님·네트워크 오류·
 * 설정 오류(incorrect_client_credentials 등)는 GithubApiError(502)로 던져 저장한 토큰을 지우지 않는다(일시 장애로 연결이 끊기지 않게).
 */
async function tokenRequest(body: Record<string, string>, deps: Deps, kind: "exchange" | "refresh"): Promise<GithubTokenSet> {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now();
  let res: Response;
  try {
    res = await doFetch(GITHUB_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": GITHUB_USER_AGENT },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new GithubApiError(`토큰 요청 실패: ${err instanceof Error ? err.name : "error"}`);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // GitHub은 실패해도 200과 { error } 를 돌려줄 수 있다.
  if (!res.ok || !json || typeof json.error === "string" || typeof json.access_token !== "string" || !json.access_token) {
    const code = typeof json?.error === "string" ? json.error.slice(0, 60) : `HTTP ${res.status}`;
    if (kind === "refresh") {
      if (typeof json?.error === "string" && REFRESH_REJECTED.has(json.error)) throw new GithubAuthError();
      if (res.status === 401 && !json) throw new GithubAuthError();
      if (json?.error === "incorrect_client_credentials") console.error("[github] 토큰 갱신 실패: GitHub App client id/secret 설정을 확인해 주세요.");
      throw new GithubApiError(`토큰 갱신 응답 오류(${code})`);
    }
    throw new GithubApiError(`토큰 응답 오류(${code})`);
  }
  const secs = (v: unknown) => (typeof v === "number" && v > 0 ? new Date(now + v * 1000) : typeof v === "string" && Number(v) > 0 ? new Date(now + Number(v) * 1000) : null);
  return {
    accessToken: json.access_token,
    accessTokenExpiresAt: secs(json.expires_in),
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    refreshTokenExpiresAt: secs(json.refresh_token_expires_in),
  };
}

export function exchangeGithubCode(
  cfg: Pick<GithubConfig, "clientId" | "clientSecret">,
  input: { code: string; state: GithubOAuthState },
  deps: Deps = {},
): Promise<GithubTokenSet> {
  return tokenRequest(
    {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code: input.code,
      redirect_uri: input.state.redirectUri,
      code_verifier: input.state.verifier,
    },
    deps,
    "exchange",
  );
}

export function refreshGithubToken(
  cfg: Pick<GithubConfig, "clientId" | "clientSecret">,
  refreshToken: string,
  deps: Deps = {},
): Promise<GithubTokenSet> {
  return tokenRequest(
    { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken },
    deps,
    "refresh",
  );
}

export function githubHeaders(token: string | null, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    Accept: accept,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface GithubUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

/** GET /user. 401이면 GithubAuthError. */
export async function fetchGithubUser(token: string, deps: Deps = {}): Promise<GithubUser> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${GITHUB_API}/user`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOKEN_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new GithubApiError(`사용자 조회 실패: ${err instanceof Error ? err.name : "error"}`);
  }
  if (res.status === 401) throw new GithubAuthError();
  const json = (await res.json().catch(() => null)) as { id?: unknown; login?: unknown; avatar_url?: unknown } | null;
  if (!res.ok || !json || (typeof json.id !== "number" && typeof json.id !== "string") || typeof json.login !== "string") {
    throw new GithubApiError(`사용자 응답 오류(HTTP ${res.status})`);
  }
  const avatar = typeof json.avatar_url === "string" && /^https:\/\/[a-z0-9.-]*githubusercontent\.com\//i.test(json.avatar_url) ? json.avatar_url.slice(0, 500) : null;
  return { id: String(json.id), login: json.login.slice(0, 39), avatarUrl: avatar };
}

/**
 * 앱 권한(grant) 해지: DELETE /applications/{client_id}/grant (Basic client_id:client_secret, 본문 access_token).
 * 사용자의 이 앱 토큰이 모두 폐기된다. 실패해도 던지지 않고 false(호출자가 로그만 남긴다 — 사용자는 GitHub 설정에서 직접 지울 수 있다).
 */
export async function revokeGithubGrantRequest(
  cfg: Pick<GithubConfig, "clientId" | "clientSecret">,
  accessToken: string,
  deps: Deps = {},
): Promise<boolean> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${GITHUB_API}/applications/${encodeURIComponent(cfg.clientId)}/grant`, {
      method: "DELETE",
      headers: {
        ...githubHeaders(null),
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
      cache: "no-store",
    });
    // 204: 해지됨, 404: 이미 없음(그래도 목적은 이뤘다).
    return res.status === 204 || res.status === 404;
  } catch {
    return false;
  }
}
