import { cookies } from "next/headers";
import {
  decodeOAuthCookie,
  exchangeCodeForClaims,
  GoogleAuthError,
  googleConfig,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  safeEqual,
} from "@/lib/auth/google";
import { loginErrorRedirect, redirectTo } from "@/lib/auth/google-redirect";
import { upsertGoogleUser } from "@/lib/auth/google-user";
import { clientIp, googleAuthLimiter } from "@/lib/auth/rate-limit";
import { createSession, sessionCookieSecure } from "@/lib/auth/session";

/** Google 로그인 콜백: state 확인 → 코드 교환 → id_token 검증 → 사용자 연결·생성 → 세션. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const store = await cookies();
  const rawCookie = store.get(OAUTH_COOKIE)?.value;
  // 성공·실패와 무관하게 일회용 쿠키는 지운다(같은 path로 덮어써야 지워진다).
  store.set(OAUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: OAUTH_COOKIE_PATH,
    maxAge: 0,
  });

  if (!googleAuthLimiter.hit(`callback|${clientIp(req)}`).ok) return loginErrorRedirect("rate_limited");

  const cfg = googleConfig();
  if (!cfg) return loginErrorRedirect("google_unavailable");

  const saved = decodeOAuthCookie(rawCookie, cfg.clientSecret);
  const next = saved?.next;

  const error = url.searchParams.get("error");
  if (error) return loginErrorRedirect(error === "access_denied" ? "access_denied" : "google_failed", next);

  const state = url.searchParams.get("state");
  if (!saved || !state || !safeEqual(state, saved.state)) return loginErrorRedirect("google_state", next);

  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return loginErrorRedirect("google_failed", next);

  let claims;
  try {
    claims = await exchangeCodeForClaims(cfg, { code, state: saved });
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      console.warn(`[auth/google] ${err.message}`);
      return loginErrorRedirect(err.code, next);
    }
    throw err;
  }

  const result = await upsertGoogleUser(claims);
  if (!result.ok) {
    return loginErrorRedirect(result.reason === "unverified_email" ? "google_link_unverified" : "google_conflict", next);
  }

  await createSession(result.userId);
  return redirectTo(saved.next);
}
