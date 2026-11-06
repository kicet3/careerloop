/**
 * 모델별 토큰 단가(USD / 100만 토큰)와 호출 비용 추정. 관리자 '사용량' 화면의 추정 비용에만 쓴다(청구 금액이 아니다).
 * Anthropic 1st-party API 정가 기준(2026-10 확인). 캐시 쓰기는 5분 TTL(입력 단가의 1.25배) 기준 — 앱은 기본 ephemeral 캐시만 쓴다.
 * 서버 측 fallback으로 여러 모델이 나눠 답하면 시도(usage.iterations)별 모델 단가로 각각 계산해 더한다(estimateCostByModel).
 * CLI 엔진(Claude·ChatGPT 계정 로그인)은 구독 사용량이라 비용을 매기지 않는다(null).
 */
import type { LlmUsage, ModelUsage } from "./types";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 캐시 쓰기(5분) = 입력 × 1.25. */
const price = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

/** 모델 id(접두 일치, 긴 것부터 비교) → 단가. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": price(10, 50, 0.25),
  // Fable 5 캐시 읽기 단가는 확인하지 못해 Fable 5.1과 같게 둔다(추정).
  "claude-fable-5": price(10, 50, 0.25),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-opus-4-7": price(5, 25, 0.5),
  "claude-opus-4-6": price(5, 25, 0.5),
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-sonnet-4-6": price(3, 15, 0.3),
  // Haiku 5.5 캐시 읽기 단가는 확인하지 못해 입력의 10%로 둔다(추정). 100K 토큰 초과 프롬프트 할증($0.50/$2.50)은
  // 반영하지 않는다 — 앱은 Haiku를 쓰지 않는다(ANTHROPIC_MODEL로 바꾸면 긴 입력의 추정 비용이 낮게 나온다).
  "claude-haiku-5-5": price(0.1, 0.5, 0.01),
  "claude-haiku-4-5": price(1, 5, 0.1),
};

const PRICE_KEYS = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);

/** 모델 이름의 단가. 날짜·[1m] 같은 꼬리는 접두 일치로 무시한다. 모르는 모델이면 null. */
export function priceFor(model: string): ModelPrice | null {
  const m = model.trim().toLowerCase();
  const key = PRICE_KEYS.find((k) => m === k || m.startsWith(`${k}-`) || m.startsWith(`${k}[`) || m.startsWith(`${k}@`));
  return key ? MODEL_PRICES[key] : null;
}

/** 추정 비용(USD 백만분의 1, 반올림 정수). 단가를 모르면 null. */
export function estimateCostMicroUsd(model: string, usage: LlmUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  // 단가가 '100만 토큰당 USD'이므로 토큰 × 단가가 곧 micro-USD다.
  const micro =
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite;
  return Math.round(micro);
}

const usedAny = (u: LlmUsage) => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0;

/** 모델별 사용량의 추정 비용 합(micro-USD). 토큰을 쓴 모델 중 하나라도 단가를 모르면 null. */
export function estimateCostByModel(parts: ModelUsage[]): number | null {
  let total = 0;
  for (const p of parts) {
    if (!usedAny(p.usage)) continue;
    const c = estimateCostMicroUsd(p.model, p.usage);
    if (c === null) return null;
    total += c;
  }
  return total;
}
