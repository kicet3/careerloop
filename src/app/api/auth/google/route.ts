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
import { loginErrorRedirect, redirectTo } from "@/lib/auth/google-redirect";
import { clientIp, googleAuthLimiter } from "@/lib/auth/rate-limit";
import { assertSameOrigin, sessionCookieSecure } from "@/lib/auth/session";
import { DEFAULT_NEXT_PATH, safeNextPath } from "@/lib/auth/validation";
import {
  encodeSignupConsentCookie,
  parseConsentForm,
  SIGNUP_CONSENT_COOKIE,
  SIGNUP_CONSENT_COOKIE_PATH,
  SIGNUP_CONSENT_TTL_MS,
} from "@/lib/legal/consent-cookie";
import type { ConsentChoices } from "@/lib/legal/consents";

/**
 * Google 로그인 시작(GET, 로그인 화면): state·PKCE·nonce를 서명 쿠키에 담고 Google 동의 화면으로 보낸다.
 * 처음 Google로 들어온 사용자는 동의 기록이 없으므로 로그인 뒤 /consent 화면을 거친다.
 */
export async function GET(req: Request) {
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  return startGoogle(req, next, null);
}

/**
 * Google 가입 시작(POST, 가입 화면의 폼 제출): 필수 동의(이용약관·개인정보 안내 확인·만 14세 이상)를 확인하고
 * 선택값을 서명 쿠키(rp_signup_consent)에 담아 Google로 보낸다. 콜백이 새 사용자의 동의 기록으로 저장한다.
 * 필수 항목이 빠지면 가입 화면으로 돌려보낸다(버튼이 비활성인데도 직접 보낸 경우).
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return signupErrorRedirect("consent_required", DEFAULT_NEXT_PATH);
  }
  const next = safeNextPath(form.get("next"));
  const choices = parseConsentForm(form);
  if (!choices) return signupErrorRedirect("consent_required", next);
  return startGoogle(req, next, choices);
}

function signupErrorRedirect(code: string, next: string): Response {
  const qs = new URLSearchParams({ error: code });
  if (next !== DEFAULT_NEXT_PATH) qs.set("next", next);
  return redirectTo(`/signup?${qs.toString()}`);
}

async function startGoogle(req: Request, next: string, consent: ConsentChoices | null): Promise<Response> {
  if (!googleAuthLimiter.hit(`start|${clientIp(req)}`).ok) return loginErrorRedirect("rate_limited", next);

  const cfg = googleConfig();
  const redirectUri = resolveRedirectUri(req);
  if (!cfg || !redirectUri) return loginErrorRedirect("google_unavailable", next);

  const store = await cookies();
  const state = newOAuthState({ next, redirectUri });
  store.set(OAUTH_COOKIE, encodeOAuthCookie(state, cfg.clientSecret), {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: OAUTH_COOKIE_PATH,
    maxAge: Math.floor(OAUTH_TTL_MS / 1000),
  });
  // 로그인 화면에서 시작하면 이전 가입 시도의 동의 쿠키를 지운다(다른 사람이 같은 브라우저에서 고른 값을 쓰지 않게).
  store.set(SIGNUP_CONSENT_COOKIE, consent ? encodeSignupConsentCookie(consent, cfg.clientSecret) : "", {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: SIGNUP_CONSENT_COOKIE_PATH,
    maxAge: consent ? Math.floor(SIGNUP_CONSENT_TTL_MS / 1000) : 0,
  });
  // POST(폼 제출) 뒤에는 303이어야 브라우저가 GET으로 Google에 간다.
  return new Response(null, {
    status: consent ? 303 : 302,
    headers: { Location: buildAuthorizationUrl(cfg, state), "Cache-Control": "no-store" },
  });
}
