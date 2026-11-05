import "server-only";
/**
 * 가입 화면에서 고른 동의를 Google 로그인 왕복 동안 들고 가는 서명 쿠키. 가입 화면의 폼 → POST /api/auth/google(same-origin 확인)이 심고,
 * 콜백(/api/auth/google/callback)이 읽어 새 사용자의 user_consents에 기록한 뒤 지운다.
 * 서명 키는 Google 클라이언트 비밀에서 용도 문자열로 파생한다(OAuth state 쿠키와 다른 키).
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/auth/google";
import { ConsentChoicesSchema, type ConsentChoices } from "./consents";

export const SIGNUP_CONSENT_COOKIE = "rp_signup_consent";
/** 콜백(/api/auth/google/callback)에도 실리도록 OAuth 쿠키와 같은 경로. */
export const SIGNUP_CONSENT_COOKIE_PATH = "/api/auth/google";
export const SIGNUP_CONSENT_TTL_MS = 10 * 60_000;

export interface SignupConsentPayload {
  choices: ConsentChoices;
  /** 사용자가 체크한(시작 요청을 보낸) 시각(ms). 동의 기록의 시각으로 쓴다. */
  at: number;
  exp: number;
}

function key(secret: string): Buffer {
  return createHmac("sha256", secret).update("rp-signup-consent-cookie-v1").digest();
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", key(secret)).update(payload).digest("base64url");
}

/** `<base64url(JSON)>.<HMAC>` */
export function encodeSignupConsentCookie(choices: ConsentChoices, secret: string, now: number = Date.now()): string {
  const body: SignupConsentPayload = { choices, at: now, exp: now + SIGNUP_CONSENT_TTL_MS };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** 서명·형식·만료·필수 항목을 확인한다. 하나라도 어긋나면 null(콜백은 동의 없이 가입시키고 /consent로 보낸다). */
export function decodeSignupConsentCookie(raw: string | undefined, secret: string, now: number = Date.now()): SignupConsentPayload | null {
  if (!raw || raw.length > 2048) return null;
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
  const o = v as Partial<SignupConsentPayload> | null;
  if (typeof o?.at !== "number" || typeof o.exp !== "number" || o.exp <= now) return null;
  const choices = ConsentChoicesSchema.safeParse(o.choices);
  return choices.success ? { choices: choices.data, at: o.at, exp: o.exp } : null;
}

/**
 * 가입 폼(POST /api/auth/google, application/x-www-form-urlencoded 또는 FormData) 필드 → 선택값.
 * 필드 terms·privacy·age14·marketing의 값이 "1"·"on"·"true"면 체크. 필수 항목이 빠지면 null.
 */
export function parseConsentForm(data: { get(name: string): unknown }): ConsentChoices | null {
  const on = (k: string) => {
    const v = data.get(k);
    return typeof v === "string" && ["1", "on", "true"].includes(v);
  };
  const parsed = ConsentChoicesSchema.safeParse({ terms: on("terms"), privacy: on("privacy"), age14: on("age14"), marketing: on("marketing") });
  return parsed.success ? parsed.data : null;
}

/** 원문 IP 대신 저장할 값: HMAC-SHA256(ip) 앞 32자. ip가 비면 null. */
export function consentIpHash(ip: string | null | undefined, secret: string): string | null {
  const v = ip?.trim();
  if (!v || v === "unknown") return null;
  return createHmac("sha256", key(secret)).update(`ip:${v}`).digest("hex").slice(0, 32);
}
