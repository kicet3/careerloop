/**
 * scheduleDraftJob 배선: 워커 스위치가 켜져 있으면 워커로 보내고(202면 Vercel 실행 없음), 아니면 지금처럼 after()에서 runResumeDraftJob.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ afterTasks: [] as (() => Promise<void>)[], runs: [] as unknown[][] }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => state.afterTasks.push(fn) }));
vi.mock("./draft-jobs", () => ({
  runResumeDraftJob: async (...args: unknown[]) => {
    state.runs.push(args);
  },
}));
vi.mock("@/lib/auth/db-rate-limit", () => ({ hitDbLimit: async () => ({ ok: true }), RESUME_DRAFT_LIMIT: {} }));

const { scheduleDraftJob } = await import("./draft-http");
const { verifySignature } = await import("@/lib/worker/sign");

const SECRET = "s".repeat(40);
const ON = { WORKER_URL: "https://worker.example.com", WORKER_SHARED_SECRET: SECRET, WORKER_JOBS: "resume-draft" };

async function drain() {
  while (state.afterTasks.length) await state.afterTasks.shift()!();
}
const fetchReturning = (status: number) =>
  vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status }));

beforeEach(() => {
  state.afterTasks = [];
  state.runs = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("scheduleDraftJob", () => {
  it("스위치가 꺼져 있으면 after()에서 runResumeDraftJob(사용자 id 포함)", async () => {
    const fetch = fetchReturning(202);
    scheduleDraftJob("ua", "j1", "r1", "anthropic", { env: {}, fetch });
    expect(state.afterTasks).toHaveLength(1);
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.runs).toEqual([["ua", "j1", "r1", "anthropic"]]);
  });

  it("켜져 있으면 워커에 (id, runId)만 서명해 보내고, 202면 Vercel에서 실행하지 않는다", async () => {
    const fetch = fetchReturning(202);
    scheduleDraftJob("ua", "j1", "r1", "anthropic", { env: ON, fetch, nowSec: () => 1_700_000_000 });
    await drain();
    expect(state.runs).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://worker.example.com/v1/jobs/resume-draft");
    expect(init?.body).toBe(JSON.stringify({ id: "j1", runId: "r1" }));
    // 본문에 사용자 id는 없다(워커가 작업 행에서 읽는다).
    expect(String(init?.body)).not.toContain("ua");
    const h = new Headers(init?.headers as Record<string, string>);
    expect(
      verifySignature(
        SECRET,
        { timestamp: h.get("x-worker-timestamp"), signature: h.get("x-worker-signature") },
        "POST",
        "/v1/jobs/resume-draft",
        String(init?.body),
        1_700_000_000,
      ),
    ).toBeNull();
  });

  it("워커가 202가 아니면(5xx·4xx·연결 실패) Vercel에서 실행한다", async () => {
    for (const fetch of [fetchReturning(503), fetchReturning(409), vi.fn(async () => Promise.reject(new TypeError("fetch failed")))]) {
      state.runs = [];
      scheduleDraftJob("ua", "j1", "r1", "anthropic", { env: ON, fetch: fetch as unknown as typeof globalThis.fetch });
      await drain();
      expect(state.runs).toEqual([["ua", "j1", "r1", "anthropic"]]);
    }
  });

  it("CLI 엔진은 워커로 보내지 않는다", async () => {
    const fetch = fetchReturning(202);
    scheduleDraftJob("ua", "j1", "r1", "claude-cli", { env: ON, fetch });
    await drain();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.runs).toEqual([["ua", "j1", "r1", "claude-cli"]]);
  });
});
