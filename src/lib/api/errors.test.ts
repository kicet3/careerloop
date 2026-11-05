import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IngestError } from "@/lib/ingest/errors";

vi.mock("server-only", () => ({}));

const { FeatureError, featureErrorResponse } = await import("./errors");

async function body(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: ((await res.json()) as { error: string }).error };
}

describe("featureErrorResponse", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("LLM 한도·과부하·연결 오류는 500이 아니라 안내 문구와 503", async () => {
    const rate = new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
    expect(await body(featureErrorResponse(rate, "t"))).toMatchObject({ status: 503, error: expect.stringContaining("요청 한도") });
    const overload = Object.assign(new Error("CLI 호출 실패"), { status: 529 });
    expect(await body(featureErrorResponse(overload, "t"))).toMatchObject({ status: 503, error: expect.stringContaining("일시적인 장애") });
    const conn = new Anthropic.APIConnectionError({ message: "down" });
    expect(await body(featureErrorResponse(conn, "t"))).toMatchObject({ status: 503, error: expect.stringContaining("연결하지 못했습니다") });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("Neo4j 연결 오류는 503, 스택 로그 없이", async () => {
    const neo = Object.assign(new Error("Could not perform discovery"), { name: "Neo4jError", code: "ServiceUnavailable" });
    expect(await body(featureErrorResponse(neo, "t"))).toMatchObject({ status: 503, error: expect.stringContaining("그래프 저장소") });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("기존 처리는 그대로: 기능 오류·수집 오류는 상태 그대로, 모르는 오류는 500", async () => {
    expect((await body(featureErrorResponse(new FeatureError("없음", 404), "t"))).status).toBe(404);
    expect((await body(featureErrorResponse(new IngestError("큼", 413), "t"))).status).toBe(413);
    expect((await body(featureErrorResponse(new TypeError("bug"), "t"))).status).toBe(500);
    expect(console.error).toHaveBeenCalledOnce();
  });
});
