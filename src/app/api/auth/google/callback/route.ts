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
import { decodeSignupConsentCookie, SIGNUP_CONSENT_COOKIE, SIGNUP_CONSENT_COOKIE_PATH } from "@/lib/legal/consent-cookie";
import { REQUIRED_CONSENT_TYPES, type ConsentChoices, type ConsentType } from "@/lib/legal/consents";
import { consentContextFromRequest, getMissingConsents, recordConsents } from "@/lib/legal/service";

/**
 * Google 로그인 콜백: state 확인 → 코드 교환 → id_token 검증 → 사용자 연결·생성 → (가입 화면에서 왔으면) 동의 기록 → 세션.
 * 동의 쿠키가 없거나 깨졌으면 기록 없이 진행하고, 앱 화면 가드가 /consent로 보낸다. 새 사용자는 승인 대기(pending)로 시작한다.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const store = await cookies();
  const rawCookie = store.get(OAUTH_COOKIE)?.value;
  const rawConsent = store.get(SIGNUP_CONSENT_COOKIE)?.value;
  // 성공·실패와 무관하게 일회용 쿠키는 지운다(같은 path로 덮어써야 지워진다).
  store.set(OAUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
  store.set(SIGNUP_CONSENT_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: sessionCookieSecure(),
    path: SIGNUP_CONSENT_COOKIE_PATH,
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

  const consent = decodeSignupConsentCookie(rawConsent, cfg.clientSecret);
  if (consent) {
    const choices = await signupConsentsToRecord(result.userId, result.created, consent.choices);
    await recordConsents(result.userId, choices, consentContextFromRequest(req, "signup", new Date(consent.at)));
  }

  await createSession(result.userId);
  return redirectTo(saved.next);
}

/**
 * 새 사용자는 고른 값을 모두 기록한다. 이미 있던 사용자가 가입 화면으로 들어온 경우에는 빠진 필수 항목만 채우고,
 * 광고성 정보 수신은 새로 체크했을 때만 기록한다(체크하지 않았다고 기존 동의를 철회로 바꾸지 않는다 — 철회는 계정 설정에서).
 */
async function signupConsentsToRecord(
  userId: string,
  created: boolean,
  choices: ConsentChoices,
): Promise<Partial<Record<ConsentType, boolean>>> {
  if (created) return choices;
  const missing = new Set(await getMissingConsents(userId));
  const out: Partial<Record<ConsentType, boolean>> = {};
  for (const t of REQUIRED_CONSENT_TYPES) if (missing.has(t)) out[t] = choices[t];
  if (choices.marketing) out.marketing = true;
  return out;
}
