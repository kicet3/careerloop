/**
 * Google 가입·로그인 왕복(PGlite): 가입 폼 POST → 동의 서명 쿠키 + 303 → 콜백이 새 사용자(pending)의 동의를 기록.
 * Google 토큰 교환(exchangeCodeForClaims)만 가짜로 바꾼다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
    set: (n: string, v: string, o?: { maxAge?: number }) => {
      if (o?.maxAge === 0 || v === "") jar.delete(n);
      else jar.set(n, v);
    },
    delete: (n: string) => void jar.delete(n),
  }),
}));
const claims = vi.hoisted(() => ({ value: { sub: "sub-new", email: "new@gmail.com", name: "새 사용자" } as Record<string, unknown> }));
vi.mock("@/lib/auth/google", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/google")>()),
  exchangeCodeForClaims: async () => claims.value,
}));

let tdb: TestDb;
let start: typeof import("./route");
let callback: typeof import("./callback/route");
let google: typeof import("@/lib/auth/google");
let consentCookie: typeof import("@/lib/legal/consent-cookie");

const ORIGIN = "http://localhost:3000";

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = "cid.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  delete process.env.APP_ENV;
  delete process.env.APP_URL;
  delete process.env.GOOGLE_REDIRECT_ORIGIN;
  delete process.env.ADMIN_EMAILS;
  tdb = await createTestDb();
  start = await import("./route");
  callback = await import("./callback/route");
  google = await import("@/lib/auth/google");
  consentCookie = await import("@/lib/legal/consent-cookie");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  await tdb.reset();
});

function signupPost(fields: Record<string, string>, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/auth/google`, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { origin, host: "localhost:3000", "content-type": "application/x-www-form-urlencoded", "user-agent": "vitest-agent" },
  });
}

/** 시작 응답의 state로 콜백 요청을 만든다. */
function callbackFor(startRes: Response): Request {
  const loc = new URL(startRes.headers.get("location")!);
  const state = loc.searchParams.get("state")!;
  return new Request(`${ORIGIN}/api/auth/google/callback?code=c&state=${state}`, {
    headers: { host: "localhost:3000", "user-agent": "vitest-agent", "x-real-ip": "203.0.113.9" },
  });
}

const ALL = { terms: "1", privacy: "1", age14: "1" };

describe("POST /api/auth/google (가입 폼)", () => {
  it("필수 동의가 있으면 서명 쿠키를 심고 303으로 Google에 보낸다", async () => {
    const res = await start.POST(signupPost({ ...ALL, marketing: "1", next: "/app/resumes" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    const raw = jar.get(consentCookie.SIGNUP_CONSENT_COOKIE);
    const decoded = consentCookie.decodeSignupConsentCookie(raw, "test-secret");
    expect(decoded?.choices).toEqual({ terms: true, privacy: true, age14: true, marketing: true });
    expect(jar.has(google.OAUTH_COOKIE)).toBe(true);
  });

  it("필수 항목이 빠지면 가입 화면으로 돌려보내고 쿠키를 심지 않는다", async () => {
    const res = await start.POST(signupPost({ terms: "1", privacy: "1", next: "/app/x" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/signup?error=consent_required&next=%2Fapp%2Fx");
    expect(jar.size).toBe(0);
  });

  it("다른 출처의 폼 제출은 403", async () => {
    expect((await start.POST(signupPost(ALL, "https://evil.example"))).status).toBe(403);
  });

  it("로그인(GET) 시작은 이전 가입 동의 쿠키를 지운다", async () => {
    await start.POST(signupPost(ALL));
    expect(jar.has(consentCookie.SIGNUP_CONSENT_COOKIE)).toBe(true);
    const res = await start.GET(new Request(`${ORIGIN}/api/auth/google`, { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(302);
    expect(jar.has(consentCookie.SIGNUP_CONSENT_COOKIE)).toBe(false);
  });
});

describe("GET /api/auth/google/callback", () => {
  it("가입 폼을 거친 새 사용자: pending으로 만들고 동의를 기록한다(IP는 해시만)", async () => {
    claims.value = { sub: "sub-new", email: "new@gmail.com", name: "새 사용자" };
    const res = await callback.GET(callbackFor(await start.POST(signupPost({ ...ALL, next: "/app/resumes" }))));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/app/resumes");
    expect(jar.has(consentCookie.SIGNUP_CONSENT_COOKIE)).toBe(false);

    const user = await tdb.prisma.user.findUniqueOrThrow({ where: { email: "new@gmail.com" } });
    expect(user.status).toBe("pending");
    const rows = await tdb.prisma.userConsent.findMany({ where: { userId: user.id }, orderBy: { type: "asc" } });
    expect(rows.map((r) => [r.type, r.agreed, r.source])).toEqual([
      ["age14", true, "signup"],
      ["marketing", false, "signup"],
      ["privacy", true, "signup"],
      ["terms", true, "signup"],
    ]);
    expect(rows[0]!.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0]!.ipHash).not.toContain("203.0.113.9");
    expect(rows[0]!.userAgent).toBe("vitest-agent");
  });

  it("로그인 화면(GET)으로 들어온 새 사용자는 동의 기록이 없다(→ /consent)", async () => {
    claims.value = { sub: "sub-login", email: "login@gmail.com", name: null };
    const startRes = await start.GET(new Request(`${ORIGIN}/api/auth/google`, { headers: { host: "localhost:3000" } }));
    await callback.GET(callbackFor(startRes));
    const user = await tdb.prisma.user.findUniqueOrThrow({ where: { email: "login@gmail.com" } });
    expect(await tdb.prisma.userConsent.count({ where: { userId: user.id } })).toBe(0);
  });

  it("기존 사용자가 가입 폼으로 오면 빠진 필수 항목만 채우고, 체크하지 않은 광고 수신은 철회로 기록하지 않는다", async () => {
    await tdb.prisma.user.create({ data: { id: "old", email: "old@gmail.com", googleSub: "sub-old", status: "approved" } });
    await tdb.prisma.userConsent.create({ data: { userId: "old", type: "marketing", version: "2026-11-06", agreed: true, source: "account" } });
    claims.value = { sub: "sub-old", email: "old@gmail.com", name: null };
    await callback.GET(callbackFor(await start.POST(signupPost(ALL))));
    const rows = await tdb.prisma.userConsent.findMany({ where: { userId: "old" } });
    expect(rows.filter((r) => r.type === "marketing").map((r) => r.agreed)).toEqual([true]);
    expect(rows.filter((r) => r.source === "signup").map((r) => r.type).sort()).toEqual(["age14", "privacy", "terms"]);
  });

  it("서명이 깨진 동의 쿠키는 무시한다", async () => {
    claims.value = { sub: "sub-x", email: "x@gmail.com", name: null };
    const startRes = await start.POST(signupPost(ALL));
    jar.set(consentCookie.SIGNUP_CONSENT_COOKIE, `${jar.get(consentCookie.SIGNUP_CONSENT_COOKIE)}x`);
    await callback.GET(callbackFor(startRes));
    const user = await tdb.prisma.user.findUniqueOrThrow({ where: { email: "x@gmail.com" } });
    expect(await tdb.prisma.userConsent.count({ where: { userId: user.id } })).toBe(0);
  });
});
