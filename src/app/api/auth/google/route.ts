import { cookies } from "next/headers";
import {
  buildAuthorizationUrl,
  encodeOAuthCookie,
  googleConfig,
  newOAuthState,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_TTL_MS,
  resolveRedirectUri,
} from "@/lib/auth/google";
import { loginErrorRedirect } from "@/lib/auth/google-redirect";
import { clientIp, googleAuthLimiter } from "@/lib/auth/rate-limit";
import { sessionCookieSecure } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/validation";

/** Google 로그인 시작: state·PKCE·nonce를 서명 쿠키에 담고 Google 동의 화면으로 보낸다. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get("next"));

  if (!googleAuthLimiter.hit(`start|${clientIp(req)}`).ok) return loginErrorRedirect("rate_limited", next);

  const cfg = googleConfig();
  const redirectUri = resolveRedirectUri(req);
  if (!cfg || !redirectUri) return loginErrorRedirect("google_unavailable", next);

  const state = newOAuthState({ next, redirectUri });
  (await cookies()).set(OAUTH_COOKIE, encodeOAuthCookie(state, cfg.clientSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: OAUTH_COOKIE_PATH,
    maxAge: Math.floor(OAUTH_TTL_MS / 1000),
  });
  return new Response(null, {
    status: 302,
    headers: { Location: buildAuthorizationUrl(cfg, state), "Cache-Control": "no-store" },
  });
}
