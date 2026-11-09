"""테스트 전용 가짜 LLM(TS src/test/fake-llm.ts FakeLlmClient의 워커판). 앱 코드에서 import하지 않는다.

- handlers: task(또는 stage) → (req) → 원시 출력(dict). 출력은 req.schema로 검증한다(TS처럼 맞지 않으면 LlmPermanentError('invalid_output')).
- errors: task → 던질 예외(한 번 쓰면 사라진다). 실패 경로·사용량 기록 테스트용.
- 사용량: input = ceil((len(system) + len(user)) / 3)(UTF-16 길이), output = 800, 모델 'fake' — TS와 같다.
- calls: 받은 요청 목록(프롬프트 확인용).
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from typing import Any

from app.jsutil import js_len
from app.llm.types import GenerateResult, LlmPermanentError, LlmRequest, LlmUsage

FAKE_MODEL_NAME = "fake"


class FakeLlmClient:
    name = "fake"

    def __init__(
        self,
        handlers: dict[str, Callable[[LlmRequest], Any]] | None = None,
        *,
        delay_sec: float = 0.0,
        errors: dict[str, BaseException] | None = None,
    ) -> None:
        self.handlers = dict(handlers or {})
        self.errors = dict(errors or {})
        self.delay_sec = delay_sec
        self.calls: list[LlmRequest] = []

    async def generate(self, req: LlmRequest) -> GenerateResult[Any]:
        self.calls.append(req)
        if self.delay_sec > 0:
            await asyncio.sleep(self.delay_sec)
        label = req.label
        if label in self.errors:
            raise self.errors.pop(label)
        handler = self.handlers.get(label)
        if handler is None:
            raise LlmPermanentError(f"가짜 출력이 없습니다 ({label})", "invalid_output")
        ok, value = req.schema.parse(handler(req))
        if not ok:
            raise LlmPermanentError(f"가짜 출력이 스키마와 맞지 않습니다 ({label})", "invalid_output")
        input_tokens = math.ceil((js_len(req.system) + js_len(req.user)) / 3)
        return GenerateResult(output=value, usage=LlmUsage(input_tokens, 800, 0, 0), model=FAKE_MODEL_NAME)
