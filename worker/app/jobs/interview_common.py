"""면접 작업 두 종류(interview-questions·interview-feedback)가 함께 쓰는 실행 도우미.

- LLM 시간 상한: TS withLlmDeadline(INTERACTIVE_LLM_TIMEOUT_MS = 240초)와 같은 값. 넘으면 사용자에게 보일 문구로 바꾼다(TS FeatureError 504).
- 결과 저장은 한 번 더 시도한다(TS saveOnce — 저장 함수가 run_id·'pending' 조건으로 중복 쓰기를 막으므로 다시 불러도 안전하다).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from app.jobs.interview_domain import InterviewFeatureError
from app.llm.types import GenerateResult, LlmClient, LlmRequest

log = logging.getLogger("worker.jobs.interview")

T = TypeVar("T")

#: TS INTERACTIVE_LLM_TIMEOUT_MS(240_000)
INTERACTIVE_LLM_TIMEOUT_SEC = 240.0
#: TS QUESTIONS_MAX_TOKENS·FEEDBACK_MAX_TOKENS
QUESTIONS_MAX_TOKENS = 32_000
FEEDBACK_MAX_TOKENS = 12_000
#: saveOnce 재시도 전 대기(초). 테스트에서 줄인다.
SAVE_RETRY_DELAY_SEC = 1.0


async def generate_with_deadline(client: LlmClient, req: LlmRequest, *, timeout_sec: float, message: str) -> GenerateResult[Any]:
    """시간 상한 안에 generate. 상한에 걸리면 InterviewFeatureError(message). 그 밖의 예외는 그대로."""
    try:
        async with asyncio.timeout(timeout_sec) as cm:
            return await client.generate(req)
    except TimeoutError:
        if cm.expired():
            raise InterviewFeatureError(message, 504) from None
        raise


async def save_once(save: Callable[[], Awaitable[T]]) -> T:
    try:
        return await save()
    except Exception as err:  # noqa: BLE001
        log.warning("interview_save_retry error=%s", type(err).__name__)
        await asyncio.sleep(SAVE_RETRY_DELAY_SEC)
        return await save()


async def swallow(aw: Awaitable[T], default: T) -> T:
    """TS `.catch(() => false)`."""
    try:
        return await aw
    except Exception as err:  # noqa: BLE001
        log.warning("interview_write_failed error=%s", type(err).__name__)
        return default
