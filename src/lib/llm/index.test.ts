import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlmClient, defaultProvider, LlmPermanentError, modelNameFor } from "./index";
import { PROVIDER_IDS, isProviderId, isRetiredEngine } from "@/lib/domain/providers";

vi.mock("server-only", () => ({}));

const req = { stage: "jd" as const, system: "s", user: "u", schema: z.object({}), maxTokens: 10 };
const prevKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
});

describe("엔진 선택(가짜 심사위원 없음)", () => {
  it("mock은 엔진 id가 아니고, 기본 엔진은 anthropic", () => {
    expect(PROVIDER_IDS).not.toContain("mock");
    expect(isProviderId("mock")).toBe(false);
    expect(defaultProvider()).toBe("anthropic");
  });

  it("API 키가 없으면 가짜 결과 대신 unavailable 오류", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(modelNameFor("anthropic")).not.toBe("mock");
    await expect(createLlmClient("anthropic", { userId: null }).generate(req as never)).rejects.toMatchObject({
      name: "LlmPermanentError",
      reason: "unavailable",
    });
  });

  it("DB에 남은 예전 'mock' 엔진 값은 호출 없이 실패한다", async () => {
    const err = await createLlmClient("mock" as never, { userId: null }).generate(req as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmPermanentError);
    expect((err as Error).message).toContain("더 이상 지원하지 않는 샘플 엔진");
  });

  it("isRetiredEngine: provider 또는 model이 mock인 예전 진단", () => {
    expect(isRetiredEngine({ provider: "mock", model: "mock" })).toBe(true);
    expect(isRetiredEngine({ provider: null, model: "mock" })).toBe(true);
    expect(isRetiredEngine({ provider: "anthropic", model: "claude-opus-5-5" })).toBe(false);
    expect(isRetiredEngine({ provider: null, model: "claude-opus-5-5" })).toBe(false);
  });
});

describe("codex 프롬프트 머리말", () => {
  it("역할을 정하지 않는다(그래프 채팅·공고 추출·이력서 초안의 역할 지시와 충돌하지 않게)", async () => {
    const { CODEX_PREAMBLE } = await import("./cli");
    expect(CODEX_PREAMBLE).not.toContain("심사위원");
    expect(CODEX_PREAMBLE).toContain("도구를 쓰지 않는다");
  });
});
