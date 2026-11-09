"""엔진별 LLM 클라이언트(TS src/lib/llm/index.ts createLlmClient의 워커판). 워커는 'anthropic'만 만든다.

- provider가 'anthropic'이 아니면 UnsupportedProviderError(CLI 엔진은 Vercel에서만 실행한다).
- ANTHROPIC_API_KEY가 없으면 호출하자마자 LlmPermanentError('unavailable')를 내는 클라이언트(사용량 기록 없음 — TS와 같다).
- 실제 클라이언트는 UsageRecordingLlmClient로 감싼다. ctx.user_id는 DB 작업 행의 user_id다.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import anthropic

from app.llm.anthropic_client import AnthropicLlmClient, anthropic_model_name
from app.llm.types import GenerateResult, LlmClient, LlmPermanentError, LlmRequest, assert_worker_provider
from app.llm.usage import LlmUsageContext, LlmUsageEvent, UsageRecordingLlmClient


class UnavailableLlmClient:
    name = "unavailable"

    def __init__(self, message: str) -> None:
        self._message = message

    async def generate(self, req: LlmRequest) -> GenerateResult[Any]:
        raise LlmPermanentError(self._message, "unavailable")


class LlmFactory:
    """프로세스당 하나. AsyncAnthropic 연결 풀을 작업들이 함께 쓴다."""

    def __init__(self, *, api_key: str | None, model: str | None, record: Callable[[LlmUsageEvent], Awaitable[None]]) -> None:
        self._api_key = api_key
        self.model = (model or "").strip() or anthropic_model_name({})
        self._record = record
        self._client: anthropic.AsyncAnthropic | None = None

    def create(self, provider: object, ctx: LlmUsageContext) -> LlmClient:
        assert_worker_provider(provider)
        if not self._api_key:
            return UnavailableLlmClient("서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다")
        if self._client is None:
            self._client = anthropic.AsyncAnthropic(api_key=self._api_key, max_retries=4)
        inner = AnthropicLlmClient(self._client, self.model)
        return UsageRecordingLlmClient(inner, provider="anthropic", model=self.model, ctx=ctx, record=self._record)

    def model_name(self) -> str:
        """작업 행의 model 열에 쓸 이름(TS modelNameFor('anthropic'))."""
        return self.model

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None
