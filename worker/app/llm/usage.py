"""LLM 토큰 사용량 기록(llm_usage_events) — TS src/lib/llm/usage.ts와 같은 열·같은 값.
성공·실패한 generate() 1건마다 1행. 프롬프트·응답 본문은 저장하지 않는다. 기록 실패는 기능에 영향을 주지 않는다(로그만 남김).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from app.jsutil import js_slice
from app.llm.pricing import estimate_cost_by_model, estimate_cost_micro_usd, js_round
from app.llm.types import GenerateResult, LlmClient, LlmPermanentError, LlmRequest, LlmUsage, ModelUsage, usage_by_model_of_error, usage_of_error

log = logging.getLogger("worker.llm_usage")

_INT_MAX = 2_147_483_647


@dataclass(frozen=True)
class LlmUsageContext:
    """호출을 누구에게 매길지. user_id는 반드시 DB 작업 행에서 읽은 값이다."""

    user_id: str | None
    reference_id: str | None = None


@dataclass
class LlmUsageEvent:
    user_id: str | None
    task: str
    stage: str | None
    provider: str
    model: str
    usage: LlmUsage
    ok: bool
    usage_by_model: list[ModelUsage] | None = None
    error_reason: str | None = None
    reference_id: str | None = None


def _clamp_int(n: Any) -> int:
    if isinstance(n, bool) or not isinstance(n, (int, float)) or n != n or n in (float("inf"), float("-inf")) or n <= 0:
        return 0
    return min(js_round(n), _INT_MAX)


_INSERT = """INSERT INTO llm_usage_events
  (user_id, task, stage, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd, ok, error_reason, reference_id)
VALUES (%(user_id)s, %(task)s, %(stage)s, %(provider)s, %(model)s, %(input_tokens)s, %(output_tokens)s, %(cache_read_tokens)s, %(cache_write_tokens)s,
  %(cost_micro_usd)s, %(ok)s, %(error_reason)s, %(reference_id)s)"""


def usage_row(e: LlmUsageEvent) -> dict[str, Any]:
    """저장할 열 값(TS recordLlmUsage의 data와 같다)."""
    is_cli = e.provider != "anthropic"
    if is_cli:
        cost = None
    elif e.usage_by_model:
        cost = estimate_cost_by_model(e.usage_by_model)
    else:
        cost = estimate_cost_micro_usd(e.model, e.usage)
    return {
        "user_id": e.user_id,
        "task": js_slice(e.task, 0, 64),
        "stage": js_slice(e.stage, 0, 64) if e.stage is not None else None,
        "provider": e.provider,
        "model": js_slice(e.model, 0, 200),
        "input_tokens": _clamp_int(e.usage.input_tokens),
        "output_tokens": _clamp_int(e.usage.output_tokens),
        "cache_read_tokens": _clamp_int(e.usage.cache_read_tokens),
        "cache_write_tokens": _clamp_int(e.usage.cache_write_tokens),
        "cost_micro_usd": cost,
        "ok": e.ok,
        "error_reason": None if e.ok else js_slice(e.error_reason or "error", 0, 64),
        "reference_id": js_slice(e.reference_id, 0, 200) if e.reference_id is not None else None,
    }


def db_usage_recorder(db: Any) -> Callable[[LlmUsageEvent], Awaitable[None]]:
    """app.db.Database로 1행을 쓰는 recorder. 예외를 밖으로 던지지 않는다."""

    async def record(e: LlmUsageEvent) -> None:
        try:
            await db.execute(_INSERT, usage_row(e))
        except Exception as err:  # noqa: BLE001
            log.error("사용량 기록 실패 (%s)", type(err).__name__)

    return record


def error_reason(error: BaseException) -> str:
    if isinstance(error, LlmPermanentError):
        return error.reason
    if isinstance(error, (asyncio.CancelledError, TimeoutError)):
        return "aborted"
    return "error"


class UsageRecordingLlmClient:
    """generate()마다 사용량을 기록하는 래퍼. 결과·오류는 그대로 돌려준다."""

    def __init__(self, inner: LlmClient, *, provider: str, model: str, ctx: LlmUsageContext, record: Callable[[LlmUsageEvent], Awaitable[None]]) -> None:
        self.inner = inner
        self.name = inner.name
        self.provider = provider
        self.model = model
        self.ctx = ctx
        self._record = record

    async def generate(self, req: LlmRequest) -> GenerateResult[Any]:
        task = req.task if req.task is not None else (req.usage_task or "diagnosis")
        stage = None if req.task is not None else req.stage
        base = {"user_id": self.ctx.user_id, "reference_id": self.ctx.reference_id, "task": task, "stage": stage, "provider": self.provider}
        try:
            result = await self.inner.generate(req)
        except BaseException as error:
            used = usage_of_error(error)
            if isinstance(error, LlmPermanentError) and error.reason == "unavailable" and (used is None or used.total() <= 0):
                raise
            event = LlmUsageEvent(
                **base,
                model=self.model,
                usage=used or LlmUsage(),
                usage_by_model=usage_by_model_of_error(error),
                ok=False,
                error_reason=error_reason(error),
            )
            # 취소 중에도 기록은 끝까지 쓴다(shield).
            await asyncio.shield(self._record(event))
            raise
        await self._record(LlmUsageEvent(**base, model=result.model or self.model, usage=result.usage, usage_by_model=result.usage_by_model, ok=True))
        return result
