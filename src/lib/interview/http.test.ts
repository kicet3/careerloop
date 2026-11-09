/**
 * 면접 백그라운드 작업 예약(scheduleGeneration·scheduleFeedback)이 dispatchJob을 거치는지:
 * 워커가 202로 받으면 Vercel 실행부를 부르지 않고, 꺼져 있거나 실패하면 지금처럼 after()에서 run…을 실행한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const afterTasks: (() => Promise<void>)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => afterTasks.push(fn) }));
const runInterviewGeneration = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
const runInterviewFeedback = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("./service", () => ({
  InterviewRateLimitError: class extends Error {},
  runInterviewGeneration: (...args: unknown[]) => runInterviewGeneration(...args),
  runInterviewFeedback: (...args: unknown[]) => runInterviewFeedback(...args),
}));
vi.mock("./store", () => ({ INTERVIEW_SESSION_NOT_FOUND: "s", INTERVIEW_QUESTION_NOT_FOUND: "q" }));

const { scheduleFeedback, scheduleGeneration } = await import("./http");
const { verifySignature } = await import("@/lib/worker/sign");

const SECRET = "s".repeat(40);
const ON = { WORKER_URL: "https://worker.example.com", WORKER_SHARED_SECRET: SECRET, WORKER_JOBS: "interview" };

async function drain() {
  while (afterTasks.length) await afterTasks.shift()!();
}

function fetchReturning(status: number) {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status }));
}

beforeEach(() => {
  afterTasks.length = 0;
  runInterviewGeneration.mockClear();
  runInterviewFeedback.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("scheduleGeneration", () => {
  it("스위치가 꺼져 있으면 워커를 부르지 않고 after()에서 runInterviewGeneration", async () => {
    const fetch = fetchReturning(202);
    scheduleGeneration("u1", "s1", "run1", "anthropic", { env: {}, fetch });
    expect(runInterviewGeneration).not.toHaveBeenCalled(); // 응답 뒤에 실행
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(runInterviewGeneration).toHaveBeenCalledWith("u1", "s1", "run1", "anthropic");
  });

  it("워커가 202로 받으면 Vercel에서 실행하지 않는다 — 본문은 세션 id·runId만(userId 없음), 서명 확인", async () => {
    const fetch = fetchReturning(202);
    scheduleGeneration("u1", "s1", "run1", "anthropic", { env: ON, fetch, nowSec: () => 1000 });
    await drain();
    expect(runInterviewGeneration).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://worker.example.com/v1/jobs/interview-questions");
    expect(init?.body).toBe('{"id":"s1","runId":"run1"}');
    const h = init?.headers as Record<string, string>;
    expect(
      verifySignature(SECRET, { timestamp: h["X-Worker-Timestamp"], signature: h["X-Worker-Signature"] }, "POST", "/v1/jobs/interview-questions", String(init?.body), 1000),
    ).toBeNull();
  });

  it.each([404, 409, 503])("워커 응답 %i이면 Vercel에서 실행한다", async (status) => {
    scheduleGeneration("u1", "s1", "run1", "anthropic", { env: ON, fetch: fetchReturning(status) });
    await drain();
    expect(runInterviewGeneration).toHaveBeenCalledTimes(1);
  });

  it("CLI 엔진은 워커로 보내지 않는다", async () => {
    const fetch = fetchReturning(202);
    scheduleGeneration("u1", "s1", "run1", "claude-cli", { env: { ...ON, WORKER_JOBS: "*" }, fetch });
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(runInterviewGeneration).toHaveBeenCalledWith("u1", "s1", "run1", "claude-cli");
  });
});

describe("scheduleFeedback", () => {
  it("워커가 202로 받으면 Vercel에서 실행하지 않는다 — id·runId 모두 답변 id", async () => {
    const fetch = fetchReturning(202);
    scheduleFeedback("u1", "a1", "anthropic", { env: ON, fetch });
    await drain();
    expect(runInterviewFeedback).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://worker.example.com/v1/jobs/interview-feedback");
    expect(init?.body).toBe('{"id":"a1","runId":"a1"}');
  });

  it("연결 실패·스위치 꺼짐이면 after()에서 runInterviewFeedback", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    scheduleFeedback("u1", "a1", "anthropic", { env: ON, fetch: failing });
    scheduleFeedback("u1", "a2", "anthropic", { env: { ...ON, WORKER_JOBS: "interview-questions" }, fetch: fetchReturning(202) });
    await drain();
    expect(runInterviewFeedback.mock.calls).toEqual([
      ["u1", "a1", "anthropic"],
      ["u1", "a2", "anthropic"],
    ]);
  });
});
