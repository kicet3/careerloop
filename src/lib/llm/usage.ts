/**
 * LLM 토큰 사용량 기록(llm_usage_events). createLlmClient()가 돌려주는 클라이언트를 UsageRecordingLlmClient로 감싸
 * 성공·실패한 generate() 1건마다 1행을 남긴다 — 모든 기능 호출이 지나는 단일 지점이다.
 * 프롬프트·응답 본문은 저장하지 않는다. 기록 실패는 기능에 영향을 주지 않는다(로그만 남김).
 */
import { prisma } from "@/lib/db/client";
import type { ProviderId } from "@/lib/domain/providers";
import Anthropic from "@anthropic-ai/sdk";
import { estimateCostByModel, estimateCostMicroUsd } from "./pricing";
import {
  LlmPermanentError,
  usageByModelOfError,
  usageOfError,
  type GenerateResult,
  type LlmClient,
  type LlmRequest,
  type LlmUsage,
  type ModelUsage,
} from "./types";

/** 호출을 누구에게 매길지. 기능 서비스가 createLlmClient(provider, ctx)로 넘긴다. */
export interface LlmUsageContext {
  /** 호출한 사용자. 사용자에 묶이지 않은 호출이면 null. */
  userId: string | null;
  /** 관련 행 id(진단·스레드·면접 세션 등) — 화면에서 묶어 보기용, 선택. */
  referenceId?: string | null;
}

export interface LlmUsageEventInput {
  userId: string | null;
  task: string;
  stage: string | null;
  provider: ProviderId;
  model: string;
  usage: LlmUsage;
  /** 모델별 사용량(서버 측 fallback). 있으면 비용을 모델별 단가로 매긴다. */
  usageByModel?: ModelUsage[] | null;
  ok: boolean;
  errorReason?: string | null;
  referenceId?: string | null;
}

const isCli = (provider: ProviderId) => provider !== "anthropic";

const clampInt = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 2_147_483_647) : 0);

/** 사용량 1행을 저장한다. 예외를 밖으로 던지지 않는다. */
export async function recordLlmUsage(e: LlmUsageEventInput): Promise<void> {
  try {
    const cost = isCli(e.provider)
      ? null
      : e.usageByModel && e.usageByModel.length > 0
        ? estimateCostByModel(e.usageByModel)
        : estimateCostMicroUsd(e.model, e.usage);
    await prisma.llmUsageEvent.create({
      data: {
        userId: e.userId,
        task: e.task.slice(0, 64),
        stage: e.stage?.slice(0, 64) ?? null,
        provider: e.provider,
        model: e.model.slice(0, 200),
        inputTokens: clampInt(e.usage.inputTokens),
        outputTokens: clampInt(e.usage.outputTokens),
        cacheReadTokens: clampInt(e.usage.cacheReadTokens),
        cacheWriteTokens: clampInt(e.usage.cacheWriteTokens),
        costMicroUsd: cost === null ? null : BigInt(cost),
        ok: e.ok,
        errorReason: e.ok ? null : (e.errorReason ?? "error").slice(0, 64),
        referenceId: e.referenceId?.slice(0, 200) ?? null,
      },
    });
  } catch (err) {
    console.error("[llm-usage] 사용량 기록 실패", err);
  }
}

const ZERO: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function errorReason(error: unknown, signal?: AbortSignal): string {
  if (error instanceof LlmPermanentError) return error.reason;
  // Anthropic SDK는 중단을 APIUserAbortError(name은 'Error')로 던지므로 클래스·넘긴 signal 상태로도 판정한다.
  if (error instanceof Anthropic.APIUserAbortError || signal?.aborted) return "aborted";
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return "aborted";
  return "error";
}

const usedAny = (u: LlmUsage | null): u is LlmUsage =>
  u !== null && u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0;

/** generate()마다 사용량을 기록하는 래퍼. 결과·오류는 그대로 돌려준다. */
export class UsageRecordingLlmClient implements LlmClient {
  readonly name: string;
  constructor(
    private readonly inner: LlmClient,
    private readonly meta: { provider: ProviderId; model: string; ctx: LlmUsageContext },
    private readonly record: (e: LlmUsageEventInput) => Promise<void> = recordLlmUsage,
  ) {
    this.name = inner.name;
  }

  async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
    const base = {
      userId: this.meta.ctx.userId,
      referenceId: this.meta.ctx.referenceId ?? null,
      task: req.task !== undefined ? req.task : (req.usageTask ?? "diagnosis"),
      stage: req.task !== undefined ? null : (req.stage ?? null),
      provider: this.meta.provider,
    };
    let result: GenerateResult<T>;
    try {
      result = await this.inner.generate(req);
    } catch (error) {
      const used = usageOfError(error);
      // 엔진을 쓸 수 없어(CLI 꺼짐·미설치) 실제 호출 없이 끝난 실패는 기록하지 않는다.
      if (error instanceof LlmPermanentError && error.reason === "unavailable" && !usedAny(used)) throw error;
      await this.record({
        ...base,
        model: this.meta.model,
        usage: used ?? ZERO,
        usageByModel: usageByModelOfError(error),
        ok: false,
        errorReason: errorReason(error, req.signal),
      });
      throw error;
    }
    await this.record({ ...base, model: result.model || this.meta.model, usage: result.usage, usageByModel: result.usageByModel ?? null, ok: true });
    return result;
  }
}
