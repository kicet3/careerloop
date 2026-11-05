import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { consentIpHash, decodeSignupConsentCookie, encodeSignupConsentCookie, parseConsentForm, SIGNUP_CONSENT_TTL_MS } = await import(
  "./consent-cookie"
);

const choices = { terms: true, privacy: true, age14: true, marketing: false } as const;

describe("가입 동의 쿠키", () => {
  it("서명한 값을 그대로 돌려받는다", () => {
    const raw = encodeSignupConsentCookie({ ...choices }, "secret", 1000);
    expect(decodeSignupConsentCookie(raw, "secret", 2000)).toEqual({ choices, at: 1000, exp: 1000 + SIGNUP_CONSENT_TTL_MS });
  });

  it("비밀이 다르거나 내용을 바꾸거나 만료되면 null", () => {
    const raw = encodeSignupConsentCookie({ ...choices }, "secret", 1000);
    expect(decodeSignupConsentCookie(raw, "other", 2000)).toBeNull();
    const [payload, sig] = raw.split(".");
    const forged = Buffer.from(JSON.stringify({ choices: { ...choices, marketing: true }, at: 1000, exp: 9e15 })).toString("base64url");
    expect(decodeSignupConsentCookie(`${forged}.${sig}`, "secret", 2000)).toBeNull();
    expect(decodeSignupConsentCookie(`${payload}.${sig}`, "secret", 1000 + SIGNUP_CONSENT_TTL_MS + 1)).toBeNull();
    expect(decodeSignupConsentCookie(undefined, "secret")).toBeNull();
    expect(decodeSignupConsentCookie("garbage", "secret")).toBeNull();
  });

  it("필수 항목이 빠진 값은 서명이 맞아도 null", () => {
    const raw = encodeSignupConsentCookie({ ...choices, age14: false } as never, "secret", 1000);
    expect(decodeSignupConsentCookie(raw, "secret", 2000)).toBeNull();
  });
});

describe("parseConsentForm", () => {
  it("필수 세 항목이 체크돼야 선택값을 돌려준다", () => {
    const form = new URLSearchParams({ terms: "on", privacy: "1", age14: "true", marketing: "on" });
    expect(parseConsentForm(form)).toEqual({ terms: true, privacy: true, age14: true, marketing: true });
    expect(parseConsentForm(new URLSearchParams({ terms: "on", privacy: "on" }))).toBeNull();
    expect(parseConsentForm(new URLSearchParams({ terms: "on", privacy: "on", age14: "on" }))?.marketing).toBe(false);
  });
});

describe("consentIpHash", () => {
  it("원문 IP를 남기지 않고 같은 IP는 같은 해시", () => {
    const a = consentIpHash("203.0.113.5", "s");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(consentIpHash("203.0.113.5", "s")).toBe(a);
    expect(consentIpHash("203.0.113.5", "t")).not.toBe(a);
    expect(consentIpHash("unknown", "s")).toBeNull();
    expect(consentIpHash("", "s")).toBeNull();
  });
});
