/** 토큰 사용량 기록(PGlite): 호출 1건 = 1행(사용자·토큰·비용), 실패도 기록, 기록 실패는 기능에 영향 없음, 탈퇴하면 함께 삭제. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDb, type TestDb } from "@/test/db";
import { createLlmClient } from "./index";
import Anthropic from "@anthropic-ai/sdk";
import { estimateCostByModel, estimateCostMicroUsd, priceFor } from "./pricing";
import { LlmPermanentError, type GenerateResult, type LlmClient, type LlmRequest, type LlmUsage } from "./types";
import { recordLlmUsage, UsageRecordingLlmClient } from "./usage";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  await tdb.prisma.user.create({ data: { id: "u1", email: "u1@x.com", status: "approved" } });
});

const usage: LlmUsage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 400 };

function fakeClient(impl: (req: LlmRequest<unknown>) => Promise<GenerateResult<unknown>>): LlmClient {
  return { name: "fake", generate: impl as LlmClient["generate"] };
}

const taskReq = { task: "graph-chat" as const, system: "s", user: "u", schema: z.object({}), effort: "low" as const };

describe("단가", () => {
  it("Opus 5.5: 입력 $4 · 출력 $20 · 캐시 읽기 $0.20 · 쓰기 $5 (100만 토큰당)", () => {
    expect(priceFor("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    // 1000×4 + 200×20 + 5000×0.2 + 400×5 = 4000 + 4000 + 1000 + 2000 micro-USD
    expect(estimateCostMicroUsd("claude-opus-5-5", usage)).toBe(11_000);
    expect(priceFor("claude-opus-5")?.input).toBe(5);
    expect(priceFor("claude-sonnet-5-5[1m]")?.input).toBe(2);
    expect(estimateCostMicroUsd("gpt-5", usage)).toBeNull();
  });
});

describe("UsageRecordingLlmClient", () => {
  it("성공한 task 호출은 사용자·작업·토큰·모델·추정 비용을 한 행으로 남긴다", async () => {
    const client = new UsageRecordingLlmClient(
      fakeClient(async () => ({ output: {}, usage, model: "claude-opus-5-5" })),
      { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId: "u1", referenceId: "thread-1" } },
    );
    const res = await client.generate(taskReq);
    expect(res.usage).toEqual(usage);
    const rows = await tdb.prisma.llmUsageEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "u1",
      task: "graph-chat",
      stage: null,
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 400,
      costMicroUsd: BigInt(11_000),
      ok: true,
      errorReason: null,
      referenceId: "thread-1",
    });
  });

  it("심사 단계 호출은 task='diagnosis'·stage, 실패는 오류에 붙은 토큰과 사유로 기록하고 오류를 그대로 던진다", async () => {
    const err = new LlmPermanentError("끊김", "max_tokens", { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const client = new UsageRecordingLlmClient(
      fakeClient(async () => {
        throw err;
      }),
      { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId: "u1" } },
    );
    await expect(client.generate({ stage: "jd", system: "s", user: "u", schema: z.object({}), effort: "low" })).rejects.toBe(err);
    const row = await tdb.prisma.llmUsageEvent.findFirstOrThrow();
    expect(row).toMatchObject({ task: "diagnosis", stage: "jd", ok: false, errorReason: "max_tokens", inputTokens: 1000, outputTokens: 200 });
    expect(row.costMicroUsd).toBe(BigInt(8_000));
  });

  it("서버 측 fallback으로 여러 모델이 나눠 쓰면 모델별 단가로 비용을 매긴다", async () => {
    const opus: LlmUsage = { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const sonnet: LlmUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const client = new UsageRecordingLlmClient(
      fakeClient(async () => ({
        output: {},
        usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
        usageByModel: [
          { model: "claude-opus-5-5", usage: opus },
          { model: "claude-sonnet-5-5", usage: sonnet },
        ],
      })),
      { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId: "u1" } },
    );
    await client.generate(taskReq);
    // opus 1000×4 + sonnet (1000×2 + 100×10) = 4000 + 3000
    expect((await tdb.prisma.llmUsageEvent.findFirstOrThrow()).costMicroUsd).toBe(BigInt(7_000));
    expect(estimateCostByModel([{ model: "unknown-model", usage: opus }])).toBeNull();
  });

  it("엔진을 쓸 수 없어 실제 호출 없이 끝난 실패(unavailable, 토큰 0)는 기록하지 않는다", async () => {
    const err = new LlmPermanentError("CLI 엔진이 꺼져 있습니다", "unavailable");
    const client = new UsageRecordingLlmClient(
      fakeClient(async () => {
        throw err;
      }),
      { provider: "claude-cli", model: "opus", ctx: { userId: "u1" } },
    );
    await expect(client.generate(taskReq)).rejects.toBe(err);
    expect(await tdb.prisma.llmUsageEvent.count()).toBe(0);
  });

  it("Anthropic SDK의 중단(APIUserAbortError)·끊긴 signal은 'aborted'로 기록한다", async () => {
    const sdkAbort = new UsageRecordingLlmClient(
      fakeClient(async () => {
        throw new Anthropic.APIUserAbortError();
      }),
      { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId: "u1" } },
    );
    await expect(sdkAbort.generate(taskReq)).rejects.toBeInstanceOf(Anthropic.APIUserAbortError);
    const ac = new AbortController();
    ac.abort();
    const signalAbort = new UsageRecordingLlmClient(
      fakeClient(async () => {
        throw new Error("boom");
      }),
      { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId: "u1" } },
    );
    await expect(signalAbort.generate({ ...taskReq, signal: ac.signal })).rejects.toThrow("boom");
    const rows = await tdb.prisma.llmUsageEvent.findMany();
    expect(rows.map((r) => r.errorReason)).toEqual(["aborted", "aborted"]);
  });

  it("CLI 엔진은 토큰만 세고 비용은 null", async () => {
    const client = new UsageRecordingLlmClient(
      fakeClient(async () => ({ output: {}, usage, model: "opus" })),
      { provider: "claude-cli", model: "opus (Claude 계정 로그인)", ctx: { userId: "u1" } },
    );
    await client.generate(taskReq);
    expect(await tdb.prisma.llmUsageEvent.findFirstOrThrow()).toMatchObject({ provider: "claude-cli", costMicroUsd: null, inputTokens: 1000 });
  });

  it("기록이 실패해도 결과는 그대로 돌려준다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 없는 사용자(FK 위반) → 저장 실패
    const client = new UsageRecordingLlmClient(
      fakeClient(async () => ({ output: { a: 1 }, usage, model: "claude-opus-5-5" })),
      { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId: "ghost" } },
    );
    await expect(client.generate(taskReq)).resolves.toMatchObject({ output: { a: 1 } });
    expect(await tdb.prisma.llmUsageEvent.count()).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("createLlmClient는 실제 엔진 클라이언트를 기록 래퍼로 감싼다(엔진이 없으면 감싸지 않는다)", () => {
    expect(createLlmClient("claude-cli", { userId: "u1" })).toBeInstanceOf(UsageRecordingLlmClient);
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(createLlmClient("anthropic", { userId: "u1" })).not.toBeInstanceOf(UsageRecordingLlmClient);
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });
});

describe("탈퇴", () => {
  it("회원을 지우면 그 회원의 사용량 행도 지워진다(CASCADE), 시스템 행은 남는다", async () => {
    await recordLlmUsage({ userId: "u1", task: "graph-qa", stage: null, provider: "anthropic", model: "claude-opus-5-5", usage, ok: true });
    await recordLlmUsage({ userId: null, task: "posting-extract", stage: null, provider: "anthropic", model: "claude-opus-5-5", usage, ok: true });
    await tdb.prisma.user.delete({ where: { id: "u1" } });
    const rows = await tdb.prisma.llmUsageEvent.findMany();
    expect(rows.map((r) => r.userId)).toEqual([null]);
  });
});
