"""Claude API 구현체 — TS src/lib/llm/anthropic.ts를 옮긴 것(규칙이 같아야 한다).

- beta messages + 서버 측 거절 fallback(betas=[server-side-fallback-2026-07-01], fallbacks="default").
- 구조화 출력: 원본 JSON Schema → strict(to_strict_json_schema)를 output_config.format에 넣고, 파싱·검증은 여기서 원본 스키마로 한다.
  API가 "compiled grammar is too large"로 거절한 스키마는 그 뒤로 format 없이 보내고 schema_instruction을 시스템 지시문에 붙인다.
- 스트리밍(get_final_message): 큰 max_tokens에서도 SDK의 비스트리밍 10분 제한에 걸리지 않도록 모든 호출에서 스트리밍을 쓴다.
- thinking·temperature는 보내지 않는다(TS와 같다). 깊이는 output_config.effort로만 조절한다 — Opus 5.5는 적응형 thinking이 항상 켜져 있고
  thinking 토큰도 max_tokens에 들어가므로, max_tokens에서 끊기면 한도를 두 배(최대 MAX_OUTPUT_TOKENS)로 올려 한 번 더 요청한다.
- 사용량: fallback이 일어나면 top-level usage는 마지막 시도만 담으므로 usage.iterations(시도별)를 합산한다.
  실패로 끝나도 그때까지의 사용량을 오류 객체의 usage·usage_by_model에 붙인다.
- 429·5xx·연결 오류는 SDK 재시도(max_retries=4)에 맡긴다. 그 뒤에도 실패하면 그대로 던진다(재시도 가능한 실패 — 작업은 '다시 시도'로 이어 간다).
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import anthropic

from app.jsutil import well_formed, well_formed_deep
from app.llm.schemas import OutputSchema
from app.llm.types import GenerateResult, LlmPermanentError, LlmRequest, LlmUsage, ModelUsage

DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
DEFAULT_MAX_TOKENS = 32000
MAX_OUTPUT_TOKENS = 128000
#: TS src/lib/panel/prompts.ts STAGE_TASK_DELIMITER.
STAGE_TASK_DELIMITER = "\n<<<STAGE_TASK>>>\n"

log = logging.getLogger("worker.llm")

#: 구조화 출력 문법이 너무 크다고 API가 거절한 스키마 이름(프로세스 수명 동안 format 없이 보낸다 — TS grammarTooLarge WeakSet).
_GRAMMAR_TOO_LARGE: set[str] = set()


def anthropic_model_name(env: dict[str, str] | None = None) -> str:
    e = os.environ if env is None else env
    return (e.get("ANTHROPIC_MODEL") or "").strip() or DEFAULT_MODEL


def split_user_prompt(user: str) -> tuple[str, str | None]:
    i = user.find(STAGE_TASK_DELIMITER)
    if i < 0:
        return user, None
    return user[:i], user[i + len(STAGE_TASK_DELIMITER) :]


def user_content(user: str, cache: bool = True) -> list[dict[str, Any]]:
    """공유 자료 블록(앞)에 캐시 지점을 둔다. TS userContent와 같다."""
    shared, task = split_user_prompt(user)
    if not cache:
        return [{"type": "text", "text": user if task is None else f"{shared}\n{task}"}]
    if task is None:
        return [{"type": "text", "text": user, "cache_control": {"type": "ephemeral"}}]
    return [{"type": "text", "text": shared, "cache_control": {"type": "ephemeral"}}, {"type": "text", "text": task}]


def schema_instruction(schema: OutputSchema) -> str:
    """스키마 강제 없이 보낼 때 시스템 지시문 뒤에 붙이는 출력 규칙. TS schemaInstruction과 같은 바이트."""
    strict = json.dumps(schema.strict, ensure_ascii=False, separators=(",", ":"))
    return (
        "\n\n# 출력 형식\n다음 JSON Schema에 정확히 맞는 JSON 객체 하나만 출력한다. 코드 블록(```)·설명 문장 없이 JSON만 쓴다. "
        "모든 필드를 빠짐없이 쓰고(없으면 빈 문자열·빈 배열), description의 {maxLength}·{maxItems} 한도를 지킨다.\n" + strict
    )


def is_grammar_too_large_error(message: str) -> bool:
    return re.search(r"compiled grammar is too large", message, re.IGNORECASE) is not None


def _as_dict(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="python")
    return dict(obj)


def _n(v: Any) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def _parts(usage: dict[str, Any]) -> list[dict[str, Any]]:
    iterations = usage.get("iterations")
    if isinstance(iterations, list) and iterations:
        return [_as_dict(u) for u in iterations]
    return [usage]


def add_usage(acc: LlmUsage, message: dict[str, Any]) -> LlmUsage:
    """응답 하나의 사용량을 더한다(iterations가 있으면 시도별 합). TS addUsage와 같다."""
    out = acc.copy()
    for u in _parts(_as_dict(message.get("usage") or {})):
        out.input_tokens += _n(u.get("input_tokens"))
        out.output_tokens += _n(u.get("output_tokens"))
        out.cache_read_tokens += _n(u.get("cache_read_input_tokens"))
        out.cache_write_tokens += _n(u.get("cache_creation_input_tokens"))
    return out


def add_usage_by_model(acc: list[ModelUsage], message: dict[str, Any], requested_model: str) -> list[ModelUsage]:
    """모델별 사용량. iterations 항목에 model이 있으면 그 모델, 없으면 fallback이 일어난 응답의 'message' 항목은 요청 모델, 그 밖은 응답 모델. TS addUsageByModel과 같다."""
    parts = _parts(_as_dict(message.get("usage") or {}))
    fell_back = any(u.get("type") == "fallback_message" for u in parts)
    out = [ModelUsage(m.model, m.usage.copy()) for m in acc]
    for u in parts:
        model = u.get("model") or (requested_model if fell_back and u.get("type") == "message" else message.get("model")) or requested_model
        slot = next((m for m in out if m.model == model), None)
        if slot is None:
            slot = ModelUsage(model, LlmUsage())
            out.append(slot)
        slot.usage.input_tokens += _n(u.get("input_tokens"))
        slot.usage.output_tokens += _n(u.get("output_tokens"))
        slot.usage.cache_read_tokens += _n(u.get("cache_read_input_tokens"))
        slot.usage.cache_write_tokens += _n(u.get("cache_creation_input_tokens"))
    return out


def text_candidates(content: list[dict[str, Any]]) -> list[str]:
    """응답 텍스트 후보: 전체 이어붙인 것과 마지막 fallback 블록 뒤의 텍스트(스트리밍 중 fallback). TS textCandidates와 같다."""

    def texts(blocks: list[dict[str, Any]]) -> str:
        return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")

    all_text = texts(content)
    last_fallback = max((i for i, b in enumerate(content) if b.get("type") == "fallback"), default=-1)
    out = [all_text]
    if last_fallback >= 0:
        after = texts(content[last_fallback + 1 :])
        if after and after != all_text:
            out.insert(0, after)
    return [t for t in out if t.strip()]


def parse_output(content: list[dict[str, Any]], schema: OutputSchema) -> tuple[bool, Any]:
    """(성공, 값 또는 문제 문자열). JSON이 아니면 가장 바깥 { … }만 다시 읽어 본다."""
    candidates = text_candidates(content)
    if not candidates:
        return False, "응답에 텍스트가 없습니다."
    problem = ""
    for text in candidates:
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as e:
            start, end = text.find("{"), text.rfind("}")
            try:
                if start < 0 or end <= start:
                    raise e
                raw = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                problem = f"JSON 파싱 실패: {e.msg}"
                continue
        ok, value = schema.parse(raw)
        if ok:
            return True, value
        problem = value
    return False, problem


class AnthropicLlmClient:
    name = "anthropic"

    def __init__(self, client: anthropic.AsyncAnthropic | None = None, model: str | None = None) -> None:
        self._client = client or anthropic.AsyncAnthropic(max_retries=4)
        self.model = model or anthropic_model_name()

    async def generate(self, req: LlmRequest) -> GenerateResult[Any]:
        state = {"usage": LlmUsage(), "by_model": []}

        def record(msg: dict[str, Any]) -> LlmUsage:
            state["usage"] = add_usage(state["usage"], msg)
            state["by_model"] = add_usage_by_model(state["by_model"], msg, self.model)
            return state["usage"]

        try:
            result = await self._generate_inner(req, record)
            result.usage_by_model = state["by_model"]
            return result
        except BaseException as e:  # 취소(CancelledError)도 — 시간 상한으로 끊긴 호출의 사용량도 남긴다
            # 실패해도 이미 쓴 토큰은 남긴다(사용량 기록·작업 사용량에 더한다).
            if getattr(e, "usage", None) is None:
                try:
                    e.usage = state["usage"]  # type: ignore[attr-defined]
                except AttributeError:
                    pass
            if getattr(e, "usage_by_model", None) is None and state["by_model"]:
                try:
                    e.usage_by_model = state["by_model"]  # type: ignore[attr-defined]
                except AttributeError:
                    pass
            raise

    async def _generate_inner(self, req: LlmRequest, record) -> GenerateResult[Any]:
        messages: list[dict[str, Any]] = [{"role": "user", "content": user_content(req.user, req.cache_user)}]
        max_tokens = req.max_tokens or DEFAULT_MAX_TOKENS
        usage = LlmUsage()
        raised_limit = False
        schema_retried = False
        for _attempt in range(3):
            msg = await self._call(req, messages, max_tokens)
            usage = record(msg)
            stop = msg.get("stop_reason")
            if stop == "refusal":
                raise LlmPermanentError(f"모델이 응답을 거절했습니다 ({req.label})", "refusal", usage)
            if stop == "model_context_window_exceeded":
                raise LlmPermanentError(f"입력이 모델 컨텍스트를 넘었습니다 ({req.label})", "context_window", usage)
            if stop == "max_tokens":
                if not raised_limit and max_tokens < MAX_OUTPUT_TOKENS:
                    raised_limit = True
                    max_tokens = min(MAX_OUTPUT_TOKENS, max_tokens * 2)
                    continue
                raise LlmPermanentError(f"응답이 출력 한도({max_tokens})에서 끊겼습니다 ({req.label})", "max_tokens", usage)
            content = [_as_dict(b) for b in msg.get("content") or []]
            ok, value = parse_output(content, req.schema)
            if ok:
                return GenerateResult(output=value, usage=usage, model=msg.get("model") or self.model)
            if schema_retried:
                break
            schema_retried = True
            previous = next(iter(text_candidates(content)), "")
            if previous:
                messages.append({"role": "assistant", "content": previous})
                messages.append(
                    {
                        "role": "user",
                        "content": f"방금 출력이 스키마 검증을 통과하지 못했다:\n{value}\n\n같은 내용을 스키마에 정확히 맞는 JSON 하나로 다시 출력한다.",
                    }
                )
            # 빈 응답이면 같은 요청을 그대로 다시 보낸다.
        raise LlmPermanentError(f"모델 출력이 스키마와 맞지 않습니다 ({req.label})", "invalid_output", usage)

    def _params(self, req: LlmRequest, messages: list[dict[str, Any]], max_tokens: int, constrained: bool) -> dict[str, Any]:
        # 보내는 모든 글(시스템·user 블록·재요청 메시지)의 외톨이 서로게이트를 U+FFFD로 — 한곳에서 한다.
        # js_slice가 이모지를 가르면 남는데, SDK는 본문을 UTF-8로 인코딩하다 실패한다(Node JSON.stringify는 이스케이프해 보낸다).
        system_text = well_formed(req.system if constrained else req.system + schema_instruction(req.schema))
        messages = well_formed_deep(messages)
        output_config: dict[str, Any] = {"effort": req.effort}
        if constrained:
            output_config["format"] = {"type": "json_schema", "schema": req.schema.strict}
        return {
            "model": self.model,
            "max_tokens": max_tokens,
            "betas": [FALLBACK_BETA],
            "fallbacks": "default",
            "system": [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "output_config": output_config,
        }

    async def _send(self, req: LlmRequest, messages: list[dict[str, Any]], max_tokens: int, constrained: bool) -> dict[str, Any]:
        async with self._client.beta.messages.stream(**self._params(req, messages, max_tokens, constrained)) as stream:
            final = await stream.get_final_message()
        return _as_dict(final)

    async def _call(self, req: LlmRequest, messages: list[dict[str, Any]], max_tokens: int) -> dict[str, Any]:
        try:
            if req.schema.name in _GRAMMAR_TOO_LARGE:
                return await self._send(req, messages, max_tokens, False)
            try:
                return await self._send(req, messages, max_tokens, True)
            except anthropic.BadRequestError as e:
                # 문법이 너무 크다는 거절은 토큰을 쓰기 전에 난다 — 이 스키마는 앞으로 스키마 강제 없이 보낸다.
                if is_grammar_too_large_error(str(e)):
                    _GRAMMAR_TOO_LARGE.add(req.schema.name)
                    log.warning("structured output grammar too large; retrying without format (%s)", req.label)
                    return await self._send(req, messages, max_tokens, False)
                raise
        except anthropic.BadRequestError as e:
            raise LlmPermanentError(f"요청이 거부되었습니다: {e}", "bad_request") from e
