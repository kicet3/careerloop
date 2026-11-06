import { cookies } from "next/headers";
import { GITHUB_CONNECT_LIMIT, hitDbLimit } from "@/lib/auth/db-rate-limit";
import { redirectTo } from "@/lib/auth/google-redirect";
import { resolveCallbackUri } from "@/lib/auth/google";
import { assertSameOrigin, requireApiUser, sessionCookieSecure } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/validation";
import {
  buildGithubAuthorizeUrl,
  encodeGithubOAuthCookie,
  GITHUB_CALLBACK_PATH,
  GITHUB_OAUTH_COOKIE,
  GITHUB_OAUTH_COOKIE_PATH,
  GITHUB_OAUTH_TTL_MS,
  githubConfig,
  newGithubOAuthState,
} from "@/lib/github/oauth";
import { withGithubParam } from "@/lib/github/redirect";

export const runtime = "nodejs";

const DEFAULT_NEXT = "/app/account";

/**
 * GitHub 연결 시작(폼 POST, 계정 설정·경험 그래프 화면): state·PKCE와 시작한 사용자 id를 서명 쿠키에 담고 GitHub 인가 화면으로 303.
 * 설정이 없거나 한도를 넘으면 next 화면으로 돌려보낸다(?github_error=…).
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  let next = DEFAULT_NEXT;
  try {
    next = safeNextPath((await req.formData()).get("next"), DEFAULT_NEXT);
  } catch {
    // 본문이 없으면 기본 화면
  }
  const cfg = githubConfig();
  const redirectUri = resolveCallbackUri(req, process.env, { path: GITHUB_CALLBACK_PATH, originEnvKey: "GITHUB_REDIRECT_ORIGIN" });
  if (!cfg || !redirectUri) return redirectTo(withGithubParam(next, { error: "github_unavailable" }));
  const limit = await hitDbLimit(GITHUB_CONNECT_LIMIT, user.id);
  if (!limit.ok) return redirectTo(withGithubParam(next, { error: "rate_limited" }));

  const state = newGithubOAuthState({ next, redirectUri, userId: user.id });
  (await cookies()).set(GITHUB_OAUTH_COOKIE, encodeGithubOAuthCookie(state, cfg.clientSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: GITHUB_OAUTH_COOKIE_PATH,
    maxAge: Math.floor(GITHUB_OAUTH_TTL_MS / 1000),
  });
  return new Response(null, { status: 303, headers: { Location: buildGithubAuthorizeUrl(cfg, state), "Cache-Control": "no-store" } });
}
