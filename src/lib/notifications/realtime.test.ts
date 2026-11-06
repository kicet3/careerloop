/**
 * 알림 실시간 수신(서버): 설정 판단·토큰 서명(HS256·ES256)·REST Broadcast(내용은 id뿐·시간 제한·던지지 않음)·토큰 API(인증·설정 없음·클레임).
 */
import { createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ user: { id: "user_A1" } as { id: string } | null }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => session.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
}));

const { realtimeConfig, signRealtimeToken, broadcastNotificationCreated } = await import("./realtime");
const route = await import("@/app/api/notifications/realtime-token/route");

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...privateKey.export({ format: "jwk" }), kid: "careerloop-rt-1" };

const BASE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co/",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_anon",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_service",
  SUPABASE_JWT_SECRET: "legacy-secret-0123456789",
};

describe("realtimeConfig", () => {
  it("URL·공개 키·서비스 키·서명 키가 모두 있어야 켜진다(별칭도 받는다)", () => {
    expect(realtimeConfig(BASE)).toMatchObject({ url: "https://abc.supabase.co", anonKey: "sb_publishable_anon", serviceKey: "sb_secret_service", signer: { alg: "HS256" } });
    for (const k of Object.keys(BASE)) expect(realtimeConfig({ ...BASE, [k]: "" })).toBeNull();
    expect(realtimeConfig({})).toBeNull();
    expect(realtimeConfig({ ...BASE, NEXT_PUBLIC_SUPABASE_URL: "not a url" })).toBeNull();
    expect(
      realtimeConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "p", SUPABASE_SECRET_KEY: "s", SUPABASE_JWT_SECRET: "j" }),
    ).toMatchObject({ url: "https://x.supabase.co", anonKey: "p", serviceKey: "s" });
  });

  it("SUPABASE_REALTIME_JWK(가져온 ES256 키)가 있으면 그것을 쓰고, 잘못된 JWK면 꺼진다", () => {
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: JSON.stringify(jwk) })?.signer).toMatchObject({ alg: "ES256", kid: "careerloop-rt-1" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: "{oops" })).toBeNull();
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: JSON.stringify([jwk]) })?.signer).toMatchObject({ alg: "ES256", kid: "careerloop-rt-1" });
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: JSON.stringify({ keys: [jwk] }) })?.signer).toMatchObject({ alg: "ES256", kid: "careerloop-rt-1" });
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: JSON.stringify([jwk, jwk]) })).toBeNull();
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: "null" })).toBeNull();
    expect(realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: JSON.stringify({ ...jwk, kid: undefined }) })).toBeNull();
    err.mockRestore();
  });
});

describe("signRealtimeToken", () => {
  const now = Date.UTC(2026, 10, 7, 0, 0, 0);
  it("HS256: sub=사용자, role/aud=authenticated, exp=1시간 뒤, 비밀로 검증된다", () => {
    const { token, expiresAt } = signRealtimeToken("user_A1", { alg: "HS256", kid: null, secret: "s3cret" }, now);
    const [h, p, s] = token.split(".");
    expect(decode(h!)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(decode(p!)).toEqual({ sub: "user_A1", role: "authenticated", aud: "authenticated", iat: now / 1000, exp: now / 1000 + 3600 });
    expect(expiresAt).toBe(now + 3600_000);
    expect(s).toBe(createHmac("sha256", "s3cret").update(`${h}.${p}`).digest("base64url"));
  });

  it("ES256: 헤더에 kid, 공개 키로 검증된다", () => {
    const signer = realtimeConfig({ ...BASE, SUPABASE_REALTIME_JWK: JSON.stringify(jwk) })!.signer;
    const { token } = signRealtimeToken("user_A1", signer, now);
    const [h, p, s] = token.split(".");
    expect(decode(h!)).toEqual({ alg: "ES256", typ: "JWT", kid: "careerloop-rt-1" });
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("broadcastNotificationCreated", () => {
  it("설정이 없으면 요청하지 않는다", async () => {
    const f = vi.fn();
    expect(await broadcastNotificationCreated("u", "n1", { env: {}, fetch: f })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("비공개 topic에 id만 보낸다 — sb_secret 키는 apikey에만", async () => {
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await broadcastNotificationCreated("user_A1", "n1", { env: BASE, fetch: f as unknown as typeof fetch })).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://abc.supabase.co/realtime/v1/api/broadcast");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ apikey: "sb_secret_service", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      messages: [{ topic: "notifications:user_A1", event: "notification", payload: { id: "n1" }, private: true }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("레거시 service_role(JWT) 키는 Authorization에도 싣는다", async () => {
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    const key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig";
    await broadcastNotificationCreated("u", "n1", { env: { ...BASE, SUPABASE_SERVICE_ROLE_KEY: key }, fetch: f as unknown as typeof fetch });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ apikey: key, Authorization: `Bearer ${key}` });
  });

  it("실패 응답·네트워크 오류·시간 초과에도 던지지 않고 false", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(async () => new Response("no", { status: 403 }));
    expect(await broadcastNotificationCreated("u", "n", { env: BASE, fetch: bad as unknown as typeof fetch })).toBe(false);
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await broadcastNotificationCreated("u", "n", { env: BASE, fetch: boom as unknown as typeof fetch })).toBe(false);
    const hang = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const started = Date.now();
    expect(await broadcastNotificationCreated("u", "n", { env: BASE, fetch: hang as unknown as typeof fetch, timeoutMs: 30 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    err.mockRestore();
  });
});

describe("GET /api/notifications/realtime-token", () => {
  beforeEach(() => {
    session.user = { id: "user_A1" };
  });
  afterEach(() => vi.unstubAllEnvs());
  const stubAll = (env: Record<string, string>) => {
    for (const k of [...Object.keys(BASE), "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_REALTIME_JWK", "SUPABASE_JWT_KID"]) {
      vi.stubEnv(k, env[k] ?? "");
    }
  };
  const get = (headers: Record<string, string> = {}) => route.GET(new Request("http://localhost/api/notifications/realtime-token", { headers }));

  it("로그인하지 않으면 401", async () => {
    stubAll(BASE);
    session.user = null;
    expect((await get()).status).toBe(401);
  });

  it("설정이 없으면 404(클라이언트는 새로고침 방식으로 남는다)", async () => {
    stubAll({});
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("내 topic과 내 sub의 토큰만 준다 — 서비스 키·비밀은 싣지 않는다", async () => {
    stubAll(BASE);
    const before = Date.now();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("sb_secret_service");
    expect(text).not.toContain(BASE.SUPABASE_JWT_SECRET);
    const body = JSON.parse(text) as import("@/lib/domain/notifications-realtime").NotificationRealtimeToken;
    expect(body).toMatchObject({ url: "https://abc.supabase.co", anonKey: "sb_publishable_anon", topic: "notifications:user_A1" });
    const claims = decode(body.token.split(".")[1]!);
    expect(claims).toMatchObject({ sub: "user_A1", role: "authenticated", aud: "authenticated" });
    expect(claims.exp).toBe(Math.floor(body.expiresAt / 1000));
    expect(body.expiresAt).toBeGreaterThan(before + 59 * 60_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
  });

  it("다른 사이트에서 연 요청은 403, 너무 잦으면 429", async () => {
    stubAll(BASE);
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    session.user = { id: "user_rate" };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await get()).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
