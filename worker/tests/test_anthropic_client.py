"""AnthropicLlmClient — SDK를 가짜로 바꿔 요청 모양·재시도·오류 분류·사용량을 확인한다(TS anthropic.test.ts와 같은 규칙)."""

from __future__ import annotations

import json
from typing import Any

import anthropic
import httpx2
import pytest

from app.llm.anthropic_client import FALLBACK_BETA, MAX_OUTPUT_TOKENS, AnthropicLlmClient, schema_instruction
from app.llm.schemas import OutputSchema
from app.llm.types import LlmPermanentError, LlmRequest

SCHEMA = OutputSchema(
    "test_answer",
    {"type": "object", "properties": {"answer": {"type": "string", "maxLength": 20}}, "required": ["answer"], "additionalProperties": False},
)


def _msg(text: str | None = None, *, stop: str = "end_turn", model: str = "claude-opus-5-5", usage: dict | None = None, content: list | None = None) -> dict:
    return {
        "model": model,
        "stop_reason": stop,
        "content": content if content is not None else ([{"type": "text", "text": text}] if text is not None else []),
        "usage": usage or {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 1, "cache_creation_input_tokens": 2},
    }


class _Stream:
    def __init__(self, result: Any) -> None:
        self._result = result

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def get_final_message(self) -> Any:
        if isinstance(self._result, BaseException):
            raise self._result
        return self._result


class FakeSdk:
    def __init__(self, results: list[Any]) -> None:
        self.results = list(results)
        self.params: list[dict[str, Any]] = []
        outer = self

        class _Messages:
            def stream(self, **params: Any) -> _Stream:
                outer.params.append(json.loads(json.dumps(params)))
                return _Stream(outer.results.pop(0))

        class _Beta:
            messages = _Messages()

        self.beta = _Beta()


def _bad_request(message: str) -> anthropic.BadRequestError:
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError(message, response=httpx2.Response(400, request=req), body=None)


def _req(**kw: Any) -> LlmRequest:
    return LlmRequest(system="SYS", user="자료\n<<<STAGE_TASK>>>\n할 일", schema=SCHEMA, effort="high", task="resume-draft", **kw)


async def test_request_shape_and_success() -> None:
    sdk = FakeSdk([_msg('{"answer":"좋음"}')])
    r = await AnthropicLlmClient(sdk, "claude-opus-5-5").generate(_req())  # type: ignore[arg-type]
    assert r.output == {"answer": "좋음"}
    assert r.usage.to_dict() == {"inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 1, "cacheWriteTokens": 2}
    assert [m.to_dict() for m in r.usage_by_model or []] == [{"model": "claude-opus-5-5", "usage": r.usage.to_dict()}]
    p = sdk.params[0]
    assert p["betas"] == [FALLBACK_BETA] and p["fallbacks"] == "default"
    assert p["max_tokens"] == 32000
    assert p["system"] == [{"type": "text", "text": "SYS", "cache_control": {"type": "ephemeral"}}]
    assert p["messages"][0]["content"] == [
        {"type": "text", "text": "자료", "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "할 일"},
    ]
    assert p["output_config"] == {"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA.strict}}
    assert "thinking" not in p and "temperature" not in p


async def test_schema_retry_then_invalid_output() -> None:
    sdk = FakeSdk([_msg('{"answer": 1}'), _msg('{"wrong": true}')])
    with pytest.raises(LlmPermanentError) as ei:
        await AnthropicLlmClient(sdk).generate(_req())  # type: ignore[arg-type]
    assert ei.value.reason == "invalid_output"
    assert ei.value.usage is not None and ei.value.usage.input_tokens == 20  # 두 번 쓴 토큰이 남는다
    retry = sdk.params[1]["messages"]
    assert retry[1] == {"role": "assistant", "content": '{"answer": 1}'}
    assert retry[2]["content"].startswith("방금 출력이 스키마 검증을 통과하지 못했다:\nanswer:")


async def test_max_tokens_raises_limit_once() -> None:
    sdk = FakeSdk([_msg(None, stop="max_tokens"), _msg(None, stop="max_tokens")])
    with pytest.raises(LlmPermanentError) as ei:
        await AnthropicLlmClient(sdk).generate(_req(max_tokens=100_000))  # type: ignore[arg-type]
    assert ei.value.reason == "max_tokens"
    assert [p["max_tokens"] for p in sdk.params] == [100_000, MAX_OUTPUT_TOKENS]


@pytest.mark.parametrize(("stop", "reason"), [("refusal", "refusal"), ("model_context_window_exceeded", "context_window")])
async def test_permanent_stops(stop: str, reason: str) -> None:
    with pytest.raises(LlmPermanentError) as ei:
        await AnthropicLlmClient(FakeSdk([_msg(None, stop=stop)])).generate(_req())  # type: ignore[arg-type]
    assert ei.value.reason == reason


async def test_grammar_too_large_falls_back_to_instruction() -> None:
    schema = OutputSchema("test_grammar_big", SCHEMA.raw)
    sdk = FakeSdk([_bad_request("The compiled grammar is too large"), _msg('```json\n{"answer":"ok"}\n```'), _msg('{"answer":"again"}')])
    client = AnthropicLlmClient(sdk)  # type: ignore[arg-type]
    req = LlmRequest(system="SYS", user="u", schema=schema, effort="low", task="resume-draft")
    r = await client.generate(req)
    assert r.output == {"answer": "ok"}  # 코드 블록이 붙어도 바깥 { … }를 읽는다
    assert sdk.params[1]["system"][0]["text"] == "SYS" + schema_instruction(schema)
    assert sdk.params[1]["output_config"] == {"effort": "low"}
    # 다음 요청부터는 바로 format 없이 보낸다(새 클라이언트 객체여도).
    await AnthropicLlmClient(sdk).generate(req)  # type: ignore[arg-type]
    assert sdk.params[2]["output_config"] == {"effort": "low"}


async def test_other_bad_request_is_permanent() -> None:
    with pytest.raises(LlmPermanentError) as ei:
        await AnthropicLlmClient(FakeSdk([_bad_request("invalid model")])).generate(_req())  # type: ignore[arg-type]
    assert ei.value.reason == "bad_request"


async def test_retryable_errors_propagate() -> None:
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    err = anthropic.InternalServerError("boom", response=httpx2.Response(500, request=req), body=None)
    with pytest.raises(anthropic.InternalServerError):
        await AnthropicLlmClient(FakeSdk([err])).generate(_req())  # type: ignore[arg-type]


async def test_fallback_usage_and_text_after_fallback_block() -> None:
    usage = {
        "input_tokens": 5,
        "output_tokens": 6,
        "iterations": [
            {"type": "message", "input_tokens": 100, "output_tokens": 1},
            {"type": "fallback_message", "model": "claude-sonnet-5-5", "input_tokens": 5, "output_tokens": 6},
        ],
    }
    content = [{"type": "text", "text": '{"answer":"부분'}, {"type": "fallback"}, {"type": "text", "text": '{"answer":"대체"}'}]
    r = await AnthropicLlmClient(FakeSdk([_msg(content=content, model="claude-sonnet-5-5", usage=usage)]), "claude-opus-5-5").generate(_req())  # type: ignore[arg-type]
    assert r.output == {"answer": "대체"}
    assert r.model == "claude-sonnet-5-5"
    assert r.usage.input_tokens == 105
    assert {m.model: m.usage.input_tokens for m in r.usage_by_model or []} == {"claude-opus-5-5": 100, "claude-sonnet-5-5": 5}
