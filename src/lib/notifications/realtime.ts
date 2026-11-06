import "server-only";
/**
 * 알림 실시간 수신(Supabase Realtime Broadcast, 비공개 채널) 서버 쪽. 설정 안내는 docs/REALTIME.md.
 *
 * - realtimeConfig(): 환경 변수가 모두 있을 때만 켜진다(없으면 null — 알림은 예전처럼 새로고침·패널 열기 때 받는다).
 * - signRealtimeToken(): 우리 사용자(Supabase Auth 사용자가 아니다)에게 Realtime용 짧은 JWT를 서명한다(role authenticated, sub = userId).
 *   서명 키는 SUPABASE_REALTIME_JWK(가져온 ES256 서명 키, 권장)가 있으면 그것, 없으면 SUPABASE_JWT_SECRET(레거시 HS256 비밀).
 * - broadcastNotificationCreated(): 새 알림 id를 REST Broadcast로 보낸다. 짧은 시간 제한, 실패해도 던지지 않는다.
 *
 * 서비스 키(SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY)와 서명 키는 서버에서만 쓴다 — 클라이언트에는 공개 키(anon/publishable)와 토큰만 간다.
 */
import { createHmac, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import {
  NOTIFICATION_REALTIME_EVENT,
  NOTIFICATION_REALTIME_TOKEN_TTL_SEC,
  notificationTopic,
  type NotificationRealtimePayload,
} from "@/lib/domain/notifications-realtime";

type Env = Record<string, string | undefined>;

export type RealtimeSigner = { alg: "ES256"; kid: string; key: KeyObject } | { alg: "HS256"; kid: string | null; secret: string };

export interface RealtimeConfig {
  /** https://<project>.supabase.co (끝 / 없음) */
  url: string;
  /** 공개 키(anon 또는 sb_publishable_…). 클라이언트에 준다. */
  anonKey: string;
  /** 서버 전용 키(service_role 또는 sb_secret_…). REST Broadcast에만 쓴다. */
  serviceKey: string;
  signer: RealtimeSigner;
}

const pick = (env: Env, ...names: string[]): string | null => {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return null;
};

let jwkCache: { raw: string; key: KeyObject } | null = null;

function parseSigner(env: Env): RealtimeSigner | null {
  const jwk = pick(env, "SUPABASE_REALTIME_JWK");
  if (jwk) {
    try {
      // 객체 하나가 정상. `supabase gen signing-key`의 출력을 배열([{...}])이나 JWK Set({"keys":[{...}]})째 넣었으면 원소가 하나일 때만 받는다.
      let raw: unknown = JSON.parse(jwk);
      if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { keys?: unknown }).keys)) raw = (raw as { keys: unknown[] }).keys;
      if (Array.isArray(raw)) {
        if (raw.length !== 1) {
          console.error("[realtime] SUPABASE_REALTIME_JWK에는 키 하나(객체 {...})만 넣어야 한다");
          return null;
        }
        raw = raw[0];
      }
      const parsed = (raw ?? {}) as { kid?: unknown; kty?: unknown; crv?: unknown; d?: unknown };
      if (typeof parsed.kid !== "string" || !parsed.kid || parsed.kty !== "EC" || parsed.crv !== "P-256" || typeof parsed.d !== "string") {
        console.error("[realtime] SUPABASE_REALTIME_JWK는 kid가 있는 EC P-256 개인 키(JWK)여야 한다");
        return null;
      }
      if (jwkCache?.raw !== jwk) jwkCache = { raw: jwk, key: createPrivateKey({ key: parsed as import("node:crypto").JsonWebKey, format: "jwk" }) };
      return { alg: "ES256", kid: parsed.kid, key: jwkCache.key };
    } catch {
      console.error("[realtime] SUPABASE_REALTIME_JWK를 읽을 수 없다(한 줄 JSON 개인 키인지 확인)");
      return null;
    }
  }
  const secret = pick(env, "SUPABASE_JWT_SECRET");
  if (secret) return { alg: "HS256", kid: pick(env, "SUPABASE_JWT_KID"), secret };
  return null;
}

/** 실시간 수신 설정. 필요한 값이 하나라도 없거나 잘못되면 null(기능 꺼짐). */
export function realtimeConfig(env: Env = process.env): RealtimeConfig | null {
  const rawUrl = pick(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
  const anonKey = pick(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY");
  const serviceKey = pick(env, "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  if (!rawUrl || !anonKey || !serviceKey) return null;
  let url: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    url = u.origin;
  } catch {
    return null;
  }
  const signer = parseSigner(env);
  if (!signer) return null;
  return { url, anonKey, serviceKey, signer };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Realtime 구독용 JWT. 이 토큰으로는 RLS 정책상 notifications:<userId> 채널만 받을 수 있다. */
export function signRealtimeToken(
  userId: string,
  signer: RealtimeSigner,
  now: number = Date.now(),
  ttlSec: number = NOTIFICATION_REALTIME_TOKEN_TTL_SEC,
): { token: string; expiresAt: number } {
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlSec;
  const header: Record<string, string> = { alg: signer.alg, typ: "JWT" };
  if (signer.kid) header.kid = signer.kid;
  const payload = { sub: userId, role: "authenticated", aud: "authenticated", iat, exp };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig =
    signer.alg === "ES256"
      ? cryptoSign("sha256", Buffer.from(input), { key: signer.key, dsaEncoding: "ieee-p1363" })
      : createHmac("sha256", signer.secret).update(input).digest();
  return { token: `${input}.${b64url(sig)}`, expiresAt: exp * 1000 };
}

/** 레거시 service_role 키는 JWT라 Authorization에도 싣는다. sb_secret_… 키는 JWT가 아니므로 apikey에만. */
const isJwt = (key: string) => key.split(".").length === 3 && key.startsWith("eyJ");

export const BROADCAST_TIMEOUT_MS = 2000;

/**
 * 새 알림을 알린다(내용 없이 id만). 설정이 없으면 아무것도 하지 않는다. 절대 던지지 않는다 — 알림 저장 결과에 영향을 주면 안 된다.
 * 성공(2xx)이면 true.
 */
export async function broadcastNotificationCreated(
  userId: string,
  notificationId: string,
  opts: { env?: Env; fetch?: typeof fetch; timeoutMs?: number; config?: RealtimeConfig | null } = {},
): Promise<boolean> {
  try {
    const cfg = opts.config !== undefined ? opts.config : realtimeConfig(opts.env);
    if (!cfg) return false;
    const payload: NotificationRealtimePayload = { id: notificationId };
    const headers: Record<string, string> = { apikey: cfg.serviceKey, "Content-Type": "application/json" };
    if (isJwt(cfg.serviceKey)) headers.Authorization = `Bearer ${cfg.serviceKey}`;
    const res = await (opts.fetch ?? fetch)(`${cfg.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: [{ topic: notificationTopic(userId), event: NOTIFICATION_REALTIME_EVENT, payload, private: true }] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? BROADCAST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[realtime] broadcast 실패", res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[realtime] broadcast 오류", (err as Error)?.name, (err as Error)?.message?.slice(0, 200));
    return false;
  }
}
