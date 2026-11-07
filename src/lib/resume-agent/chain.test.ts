import { describe, expect, it, vi } from "vitest";
import { CHAIN_SIGNATURE_HEADER, chainOrigin, chainSecret, requestChain, signAdvance, verifyAdvance } from "./chain";

const SECRET = "s".repeat(40);

describe("chainOrigin", () => {
  it("APP_ORIGIN → 운영 도메인 → 미리보기(배포 고유 주소 + 우회 비밀) → 없음", () => {
    expect(chainOrigin({ APP_ORIGIN: "https://app.example.com/x" })).toBe("https://app.example.com");
    expect(chainOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "careerloop.app", VERCEL_URL: "x-123.vercel.app" })).toBe("https://careerloop.app");
    expect(chainOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "x-123.vercel.app" })).toBeNull();
    expect(chainOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "x-123.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "b" })).toBe("https://x-123.vercel.app");
    expect(chainOrigin({})).toBeNull();
  });
  it("비밀은 32자 이상만", () => {
    expect(chainSecret({ RESUME_AGENT_CHAIN_SECRET: "short" })).toBeNull();
    expect(chainSecret({ RESUME_AGENT_CHAIN_SECRET: SECRET })).toBe(SECRET);
  });
});

describe("서명", () => {
  const now = 1_000_000;
  const exp = now + 60_000;
  const sig = signAdvance(SECRET, "job1", "run1", exp);
  it("맞는 서명·만료 전이면 통과", () => {
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp, signature: sig }, now)).toBe(true);
  });
  it("만료·위조·다른 runId·다른 길이·너무 먼 exp는 거부", () => {
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp, signature: sig }, exp + 1)).toBe(false);
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run2", exp, signature: sig }, now)).toBe(false);
    expect(verifyAdvance("x".repeat(40), { jobId: "job1", runId: "run1", exp, signature: sig }, now)).toBe(false);
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp, signature: sig.slice(0, 40) }, now)).toBe(false);
    const far = now + 60 * 60_000;
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp: far, signature: signAdvance(SECRET, "job1", "run1", far) }, now)).toBe(false);
  });
});

describe("requestChain", () => {
  it("비밀·origin이 있으면 서명과(미리보기면) 보호 우회 헤더로 202만 기다린다", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const env = { RESUME_AGENT_CHAIN_SECRET: SECRET, VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "bypass" };
    expect(await requestChain({ id: "j", runId: "r" }, env, fetchImpl as unknown as typeof fetch, 5)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.vercel.app/api/internal/resume-agent/advance");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-vercel-protection-bypass"]).toBe("bypass");
    const body = JSON.parse(String(init.body)) as { exp: number };
    expect(verifyAdvance(SECRET, { jobId: "j", runId: "r", exp: body.exp, signature: headers[CHAIN_SIGNATURE_HEADER]! }, 5)).toBe(true);
  });
  it("꺼져 있거나 실패하면 던지지 않고 사유를 돌려준다", async () => {
    expect(await requestChain({ id: "j", runId: "r" }, {})).toEqual({ ok: false, error: "chain_disabled" });
    const env = { RESUME_AGENT_CHAIN_SECRET: SECRET, APP_ORIGIN: "https://a.example" };
    const bad = vi.fn(async () => new Response(null, { status: 401 }));
    expect(await requestChain({ id: "j", runId: "r" }, env, bad as unknown as typeof fetch)).toEqual({ ok: false, error: "status_401" });
  });
});
