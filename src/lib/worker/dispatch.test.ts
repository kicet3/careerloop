import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const afterTasks: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => afterTasks.push(fn) }));

const { dispatchJob, sendToWorker } = await import("./dispatch");
const { isJobEnabled, parseWorkerJobs, workerConfig } = await import("./config");
const { verifySignature } = await import("./sign");

const SECRET = "s".repeat(40);
const ENV = { WORKER_URL: "https://worker.example.com/", WORKER_SHARED_SECRET: SECRET, WORKER_JOBS: "resume-draft,interview" };
const payload = { id: "job_1", runId: "run_1", provider: "anthropic" };

async function drain() {
  while (afterTasks.length) await afterTasks.shift()!();
}

function fetchReturning(status: number) {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status }));
}

beforeEach(() => {
  afterTasks.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("workerConfig / WORKER_JOBS", () => {
  it("주소·비밀값이 맞을 때만 켠다", () => {
    expect(workerConfig(ENV)).toEqual({ url: "https://worker.example.com", secret: SECRET, jobs: ["resume-draft", "interview"] });
    expect(workerConfig({ ...ENV, WORKER_URL: "" })).toBeNull();
    expect(workerConfig({ ...ENV, WORKER_SHARED_SECRET: "short" })).toBeNull();
    expect(workerConfig({ ...ENV, WORKER_URL: "http://worker.example.com" })).toBeNull();
    expect(workerConfig({ ...ENV, WORKER_URL: "https://worker.example.com/base" })).toBeNull();
    expect(workerConfig({ ...ENV, WORKER_URL: "not a url" })).toBeNull();
    expect(workerConfig({ ...ENV, WORKER_URL: "http://127.0.0.1:8090" })?.url).toBe("http://127.0.0.1:8090");
  });

  it("공유 fixture(worker_jobs.json)와 같은 규칙으로 해석한다", () => {
    const cases = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../worker/tests/fixtures/worker_jobs.json"), "utf8")) as {
      raw: string;
      jobs: string[];
      enabled: Record<string, boolean>;
    }[];
    for (const c of cases) {
      expect(parseWorkerJobs(c.raw)).toEqual(c.jobs);
      for (const [kind, on] of Object.entries(c.enabled)) expect(isJobEnabled(c.jobs, kind)).toBe(on);
    }
  });
});

describe("dispatchJob", () => {
  it("스위치가 꺼져 있으면 워커를 부르지 않고 after(fallback)", async () => {
    const fetch = fetchReturning(202);
    const fallback = vi.fn(async () => undefined);
    dispatchJob("resume-draft", payload, fallback, { env: { ...ENV, WORKER_URL: undefined }, fetch });
    dispatchJob("portfolio-graph", payload, fallback, { env: ENV, fetch }); // WORKER_JOBS에 없음
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("202면 fallback을 실행하지 않는다 — 서명·본문(id·runId만)을 확인", async () => {
    const fetch = fetchReturning(202);
    const fallback = vi.fn(async () => undefined);
    dispatchJob("interview-questions", { ...payload, userId: "u_evil" } as never, fallback, { env: ENV, fetch, nowSec: () => 1000 });
    expect(fetch).not.toHaveBeenCalled(); // 응답 뒤(after)에 보낸다
    await drain();
    expect(fallback).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://worker.example.com/v1/jobs/interview-questions");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"id":"job_1","runId":"run_1"}');
    const h = init?.headers as Record<string, string>;
    expect(
      verifySignature(SECRET, { timestamp: h["X-Worker-Timestamp"], signature: h["X-Worker-Signature"] }, "POST", "/v1/jobs/interview-questions", String(init?.body), 1000),
    ).toBeNull();
  });

  it.each([500, 503, 401, 404, 409, 200])("응답 %i이면 fallback", async (status) => {
    const fallback = vi.fn(async () => undefined);
    dispatchJob("resume-draft", payload, fallback, { env: ENV, fetch: fetchReturning(status) });
    await drain();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("연결 실패면 fallback", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const fallback = vi.fn(async () => undefined);
    dispatchJob("resume-draft", payload, fallback, { env: ENV, fetch });
    await drain();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("타임아웃이면 fallback", async () => {
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const fallback = vi.fn(async () => undefined);
    dispatchJob("resume-draft", payload, fallback, { env: ENV, fetch, timeoutMs: 20 });
    await drain();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await sendToWorker("resume-draft", payload, { env: ENV, fetch, timeoutMs: 20 })).toEqual({ sent: false, reason: "timeout" });
  });

  it.each(["claude-cli", "codex-cli", null])("엔진이 %s면 워커로 보내지 않는다", async (provider) => {
    const fetch = fetchReturning(202);
    const fallback = vi.fn(async () => undefined);
    dispatchJob("resume-draft", { ...payload, provider }, fallback, { env: { ...ENV, WORKER_JOBS: "*" }, fetch });
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
