"""모델별 토큰 단가(USD / 100만 토큰)와 호출 비용 추정 — TS src/lib/llm/pricing.ts와 같은 표·같은 계산(tests/fixtures/pricing.json으로 확인).
관리자 '사용량' 화면의 추정 비용에만 쓴다(청구 금액이 아니다). 캐시 쓰기는 5분 TTL(입력 단가의 1.25배).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.llm.types import LlmUsage, ModelUsage


@dataclass(frozen=True)
class ModelPrice:
    input: float
    output: float
    cache_read: float
    cache_write: float


def _price(input_: float, output: float, cache_read: float) -> ModelPrice:
    return ModelPrice(input_, output, cache_read, input_ * 1.25)


#: 모델 id(접두 일치, 긴 것부터 비교) → 단가. TS MODEL_PRICES와 같아야 한다.
MODEL_PRICES: dict[str, ModelPrice] = {
    "claude-fable-5-1": _price(10, 50, 0.25),
    "claude-fable-5": _price(10, 50, 0.25),
    "claude-opus-5-5": _price(4, 20, 0.2),
    "claude-opus-5": _price(5, 25, 0.5),
    "claude-opus-4-8": _price(5, 25, 0.5),
    "claude-opus-4-7": _price(5, 25, 0.5),
    "claude-opus-4-6": _price(5, 25, 0.5),
    "claude-sonnet-5-5": _price(2, 10, 0.2),
    "claude-sonnet-5": _price(2, 10, 0.2),
    "claude-sonnet-4-6": _price(3, 15, 0.3),
    "claude-haiku-5-5": _price(0.1, 0.5, 0.01),
    "claude-haiku-4-5": _price(1, 5, 0.1),
}

_PRICE_KEYS = sorted(MODEL_PRICES, key=len, reverse=True)


def price_for(model: str) -> ModelPrice | None:
    m = model.strip().lower()
    for k in _PRICE_KEYS:
        if m == k or m.startswith(f"{k}-") or m.startswith(f"{k}[") or m.startswith(f"{k}@"):
            return MODEL_PRICES[k]
    return None


def js_round(x: float) -> int:
    """Math.round(.5는 +∞ 쪽)."""
    return math.floor(x + 0.5)


def estimate_cost_micro_usd(model: str, usage: LlmUsage) -> int | None:
    p = price_for(model)
    if p is None:
        return None
    micro = usage.input_tokens * p.input + usage.output_tokens * p.output + usage.cache_read_tokens * p.cache_read + usage.cache_write_tokens * p.cache_write
    return js_round(micro)


def estimate_cost_by_model(parts: list[ModelUsage]) -> int | None:
    total = 0
    for p in parts:
        if p.usage.total() <= 0:
            continue
        c = estimate_cost_micro_usd(p.model, p.usage)
        if c is None:
            return None
        total += c
    return total
