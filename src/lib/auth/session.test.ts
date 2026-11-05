import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// session.ts가 끌어오는 DB·Next 요청 API는 이 테스트에서 쓰지 않는다.
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));

const { assertSameOrigin, sessionCookieSecure } = await import("./session");

describe("sessionCookieSecure", () => {
  it("PRODUCTION이면 NODE_ENV와 무관하게 Secure", () => {
    expect(sessionCookieSecure({ APP_ENV: "PRODUCTION", NODE_ENV: "development" })).toBe(true);
    expect(sessionCookieSecure({ APP_ENV: "PRODUCTION" })).toBe(true);
  });

  it("DEV는 프로덕션 빌드일 때만 Secure", () => {
    expect(sessionCookieSecure({ NODE_ENV: "development" })).toBe(false);
    expect(sessionCookieSecure({ APP_ENV: "DEV", NODE_ENV: "production" })).toBe(true);
  });
});

function req(headers: Record<string, string>, url = "http://internal:3000/api/x") {
  return new Request(url, { method: "POST", headers });
}

describe("assertSameOrigin", () => {
  const prod = { APP_ENV: "PRODUCTION", APP_URL: "https://resume.example.com" };

  it("DEV는 Host·X-Forwarded-Host·APP_URL을 허용한다", () => {
    expect(assertSameOrigin(req({ origin: "http://box.ts.net:3000", host: "box.ts.net:3000" }), {})).toBeNull();
    expect(assertSameOrigin(req({ origin: "https://proxy.dev", "x-forwarded-host": "proxy.dev" }), {})).toBeNull();
    expect(assertSameOrigin(req({ origin: "https://evil.com", host: "box:3000" }), {})?.status).toBe(403);
  });

  it("PRODUCTION은 APP_URL 호스트만 허용하고 Host 헤더를 믿지 않는다", () => {
    expect(assertSameOrigin(req({ origin: "https://resume.example.com", host: "internal:3000" }), prod)).toBeNull();
    expect(assertSameOrigin(req({ origin: "https://evil.com", host: "evil.com" }), prod)?.status).toBe(403);
    expect(assertSameOrigin(req({ origin: "https://evil.com", "x-forwarded-host": "evil.com" }), prod)?.status).toBe(403);
    expect(assertSameOrigin(req({ origin: "http://internal:3000" }), prod)?.status).toBe(403);
  });

  it("Origin이 없으면 Sec-Fetch-Site로만 판단한다", () => {
    expect(assertSameOrigin(req({}), prod)).toBeNull();
    expect(assertSameOrigin(req({ "sec-fetch-site": "cross-site" }), prod)?.status).toBe(403);
  });
});
