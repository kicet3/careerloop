/**
 * 포트폴리오 작업 예약(scheduleGraphPortfolioJob) → dispatchJob('portfolio-graph') 연결:
 * 스위치가 꺼져 있거나 CLI 엔진이면 지금처럼 after()에서 runGraphPortfolioJob, 켜져 있으면 워커에 (id, runId)만 서명해 보내고 202면 실행하지 않으며,
 * 워커가 받지 않으면(5xx·네트워크 오류) Vercel에서 실행한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const afterTasks: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => afterTasks.push(fn) }));
const run = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("./graph-jobs", () => ({ runGraphPortfolioJob: (...args: unknown[]) => run(...args) }));

const { scheduleGraphPortfolioJob } = await import("./graph-http");
const { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } = await import("@/lib/worker/sign");

const SECRET = "s".repeat(40);
const ON = { WORKER_URL: "https://worker.example.com", WORKER_SHARED_SECRET: SECRET, WORKER_JOBS: "portfolio-graph" };

async function drain() {
  while (afterTasks.length) await afterTasks.shift()!();
}
const fetchReturning = (status: number) =>
  vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status }));

beforeEach(() => {
  afterTasks.length = 0;
  run.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("scheduleGraphPortfolioJob", () => {
  it("스위치가 꺼져 있으면(기본) after()에서 Vercel 실행 — 워커를 부르지 않는다", async () => {
    const fetch = fetchReturning(202);
    scheduleGraphPortfolioJob("ua", "job_1", "run_1", "anthropic", { env: {}, fetch });
    scheduleGraphPortfolioJob("ua", "job_2", "run_2", "anthropic", { env: { ...ON, WORKER_JOBS: "resume-draft" }, fetch });
    expect(run).not.toHaveBeenCalled();
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(run.mock.calls).toEqual([
      ["ua", "job_1", "run_1", "anthropic"],
      ["ua", "job_2", "run_2", "anthropic"],
    ]);
  });

  it("CLI 엔진은 켜져 있어도 Vercel에서 실행한다", async () => {
    const fetch = fetchReturning(202);
    scheduleGraphPortfolioJob("ua", "job_1", "run_1", "claude-cli", { env: ON, fetch });
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("켜져 있고 워커가 202면 Vercel에서 실행하지 않는다. 본문은 id·runId뿐이고 서명이 맞다", async () => {
    const fetch = fetchReturning(202);
    scheduleGraphPortfolioJob("ua", "job_1", "run_1", "anthropic", { env: ON, fetch, nowSec: () => 1_700_000_000 });
    await drain();
    expect(run).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://worker.example.com/v1/jobs/portfolio-graph");
    expect(JSON.parse(String(init!.body))).toEqual({ id: "job_1", runId: "run_1" });
    expect(String(init!.body)).not.toContain("ua");
    const h = init!.headers as Record<string, string>;
    const headers = { timestamp: h[TIMESTAMP_HEADER], signature: h[SIGNATURE_HEADER] };
    expect(verifySignature(SECRET, headers, "POST", "/v1/jobs/portfolio-graph", String(init!.body), 1_700_000_000)).toBeNull();
  });

  it("워커가 받지 않으면(503·네트워크 오류) Vercel에서 실행한다", async () => {
    scheduleGraphPortfolioJob("ua", "job_1", "run_1", "anthropic", { env: ON, fetch: fetchReturning(503) });
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    scheduleGraphPortfolioJob("ua", "job_2", "run_2", "anthropic", { env: { ...ON, WORKER_JOBS: "*" }, fetch: failing as unknown as typeof fetch });
    await drain();
    expect(run.mock.calls.map((c) => c[1])).toEqual(["job_1", "job_2"]);
  });
});
