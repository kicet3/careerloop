import { cookies } from "next/headers";
import { safeEqual } from "@/lib/auth/google";
import { redirectTo } from "@/lib/auth/google-redirect";
import { clientIp, googleAuthLimiter } from "@/lib/auth/rate-limit";
import { getCurrentUser, sessionCookieSecure } from "@/lib/auth/session";
import { saveGithubConnection } from "@/lib/github/account";
import {
  decodeGithubOAuthCookie,
  exchangeGithubCode,
  fetchGithubUser,
  GITHUB_OAUTH_COOKIE,
  GITHUB_OAUTH_COOKIE_PATH,
  githubConfig,
} from "@/lib/github/oauth";
import { withGithubParam } from "@/lib/github/redirect";
import { GithubError } from "@/lib/github/types";

export const runtime = "nodejs";

const DEFAULT_NEXT = "/app/account";

/**
 * GitHub 연결 콜백: 일회용 쿠키를 지우고 → state 확인 → 로그인한 사용자가 연결을 시작한 사용자와 같은지 확인(로그인 CSRF 방지)
 * → 코드 교환(PKCE) → GET /user → 토큰을 암호화해 저장 → next 화면(?github=connected 또는 ?github_error=<코드>).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const store = await cookies();
  const raw = store.get(GITHUB_OAUTH_COOKIE)?.value;
  store.set(GITHUB_OAUTH_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure(), path: GITHUB_OAUTH_COOKIE_PATH, maxAge: 0 });

  if (!googleAuthLimiter.hit(`github-callback|${clientIp(req)}`).ok) return redirectTo(withGithubParam(DEFAULT_NEXT, { error: "rate_limited" }));
  const cfg = githubConfig();
  if (!cfg) return redirectTo(withGithubParam(DEFAULT_NEXT, { error: "github_unavailable" }));

  const saved = decodeGithubOAuthCookie(raw, cfg.clientSecret);
  const next = saved?.next ?? DEFAULT_NEXT;
  const fail = (code: string) => redirectTo(withGithubParam(next, { error: code }));

  const error = url.searchParams.get("error");
  if (error) return fail(error === "access_denied" ? "access_denied" : "github_failed");
  const state = url.searchParams.get("state");
  if (!saved || !state || !safeEqual(state, saved.state)) return fail("github_state");

  const user = await getCurrentUser();
  if (!user) return redirectTo(`/login?next=${encodeURIComponent(next)}`);
  if (user.id !== saved.userId) return fail("github_session");

  const code = url.searchParams.get("code");
  if (!code || code.length > 512) return fail("github_failed");

  try {
    const tokens = await exchangeGithubCode(cfg, { code, state: saved });
    const ghUser = await fetchGithubUser(tokens.accessToken);
    const result = await saveGithubConnection(user.id, ghUser, tokens, cfg);
    if (!result.ok) return fail("github_conflict");
  } catch (err) {
    if (err instanceof GithubError) {
      console.warn(`[github/callback] ${err.name}: ${(err as { detail?: string }).detail ?? err.message}`);
      return fail("github_failed");
    }
    throw err;
  }
  return redirectTo(withGithubParam(next, { connected: true }));
}
