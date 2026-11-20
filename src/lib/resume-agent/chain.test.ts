import { describe, expect, it, vi } from "vitest";
import { agentRunnerOrigin, CHAIN_SIGNATURE_HEADER, chainOrigin, isAgentRunner, chainSecret, requestChain, signAdvance, verifyAdvance } from "./chain";

const SECRET = "s".repeat(40);

describe("chainOrigin", () => {
  it("APP_ORIGIN → 운영 도메인 → 미리보기(배포 고유 주소 + 우회 비밀) → 없음", () => {
    expect(chainOrigin({ APP_ORIGIN: "https://app.example.com/x" })).toBe("https://app.example.com");
    expect(chainOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "careerloop.app", VERCEL_URL: "x-123.vercel.app" })).toBe("https://careerloop.app");
    expect(chainOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "x-123.vercel.app" })).toBeNull();
    expect(chainOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "x-123.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "b" })).toBe("https://x-123.vercel.app");
    expect(chainOrigin({})).toBeNull();
  });
  it("실행기(RESUME_AGENT_RUNNER_URL)가 있으면 연쇄 대상은 실행기 — https만(로컬 http는 점검용), 실행기 자신은 넘기지 않는다", () => {
    const vercel = { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "careerloop.app" };
    expect(agentRunnerOrigin({ RESUME_AGENT_RUNNER_URL: "https://agent.example.com/x" })).toBe("https://agent.example.com");
    expect(chainOrigin({ ...vercel, RESUME_AGENT_RUNNER_URL: "https://agent.example.com" })).toBe("https://agent.example.com");
    expect(agentRunnerOrigin({ RESUME_AGENT_RUNNER_URL: "http://agent.example.com" })).toBeNull();
    expect(agentRunnerOrigin({ RESUME_AGENT_RUNNER_URL: "http://127.0.0.1:3100" })).toBe("http://127.0.0.1:3100");
    expect(agentRunnerOrigin({ RESUME_AGENT_RUNNER_URL: "not a url" })).toBeNull();
    expect(chainOrigin({ ...vercel, RESUME_AGENT_RUNNER_URL: "nope" })).toBe("https://careerloop.app");
    const runner = { RESUME_AGENT_RUNNER: "1", RESUME_AGENT_RUNNER_URL: "https://agent.example.com", APP_ORIGIN: "http://127.0.0.1:3000" };
    expect(isAgentRunner(runner)).toBe(true);
    expect(agentRunnerOrigin(runner)).toBeNull();
    expect(chainOrigin(runner)).toBe("http://127.0.0.1:3000");
    expect(isAgentRunner({})).toBe(false);
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
    // 두 서버의 시계 차이 60초까지는 허용한다(그 밖은 거부).
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp, signature: sig }, exp + 1)).toBe(true);
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp, signature: sig }, exp + 60_001)).toBe(false);
    expect(verifyAdvance(SECRET, { jobId: "job1", runId: "run1", exp, signature: sig }, exp - 120_000 - 60_001)).toBe(false);
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
  it("실행기가 있으면 실행기에 먼저 보내고(우회 비밀은 안 보냄), 안 받으면 자기 호출로 이어 간다. 'runner'는 실행기에만", async () => {
    const env = { RESUME_AGENT_CHAIN_SECRET: SECRET, RESUME_AGENT_RUNNER_URL: "https://agent.example.com", VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app", VERCEL_AUTOMATION_BYPASS_SECRET: "bypass" };
    const calls: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
    const impl = (statusFor: (url: string) => number) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
        return new Response(null, { status: statusFor(url) });
      }) as unknown as typeof fetch;
    expect(await requestChain({ id: "j", runId: "r" }, env, impl(() => 202), 5)).toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(["https://agent.example.com/api/internal/resume-agent/advance"]);
    expect(calls[0]!.headers["x-vercel-protection-bypass"]).toBeUndefined();
    expect(calls[0]!.redirect).toBe("manual");
    calls.length = 0;
    expect(await requestChain({ id: "j", runId: "r" }, env, impl((u) => (u.includes("agent.example.com") ? 409 : 202)), 5)).toEqual({ ok: true });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["agent.example.com", "x.vercel.app"]);
    expect(calls[1]!.headers["x-vercel-protection-bypass"]).toBe("bypass");
    calls.length = 0;
    expect(await requestChain({ id: "j", runId: "r" }, env, impl(() => 502), 5, "runner")).toEqual({ ok: false, error: "runner_status_502" });
    expect(calls).toHaveLength(1);
    // 실행기 자신은 자기에게만 보낸다. Vercel에서는 실행기 표시가 켜지지 않는다.
    calls.length = 0;
    await requestChain({ id: "j", runId: "r" }, { RESUME_AGENT_CHAIN_SECRET: SECRET, RESUME_AGENT_RUNNER: "1", RESUME_AGENT_RUNNER_URL: "https://agent.example.com", APP_ORIGIN: "http://127.0.0.1:3000" }, impl(() => 202), 5);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["127.0.0.1:3000"]);
    expect(isAgentRunner({ RESUME_AGENT_RUNNER: "1", VERCEL: "1" })).toBe(false);
  });
});
