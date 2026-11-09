"""LLM 경계(TS src/lib/llm/types.ts). 작업 코드는 LlmClient 프로토콜만 알고, 테스트는 tests/fake_llm.py FakeLlmClient를 주입한다.

워커는 'anthropic' 엔진만 지원한다. CLI 엔진(claude-cli·codex-cli)은 사용자 계정 로그인 정보가 Vercel 쪽에만 있어 실행하지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Protocol, TypeVar

from app.llm.schemas import OutputSchema

Effort = Literal["low", "medium", "high", "xhigh", "max"]

PermanentReason = Literal[
    "refusal",
    "invalid_output",
    "max_tokens",
    "context_window",
    "bad_request",
    "auth",
    "usage_limit",
    "unavailable",
    "timeout",
]

T = TypeVar("T")


@dataclass
class LlmUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def total(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens

    def copy(self) -> LlmUsage:
        return LlmUsage(self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens)

    def to_dict(self) -> dict[str, int]:
        """TS LlmUsage와 같은 모양(camelCase) — 작업 행 JSON 열에 그대로 쓴다."""
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cacheReadTokens": self.cache_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> LlmUsage:
        def n(k: str) -> int:
            v = d.get(k)
            return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

        return LlmUsage(n("inputTokens"), n("outputTokens"), n("cacheReadTokens"), n("cacheWriteTokens"))


@dataclass
class ModelUsage:
    model: str
    usage: LlmUsage

    def to_dict(self) -> dict[str, Any]:
        return {"model": self.model, "usage": self.usage.to_dict()}


@dataclass
class LlmRequest:
    """TS LlmRequest. task(파이프라인 밖 기능) 또는 stage(심사 단계) 중 하나를 준다."""

    system: str
    user: str
    schema: OutputSchema
    effort: Effort
    task: str | None = None
    stage: str | None = None
    #: 사용량 기록 task(stage 호출에서만, 기본 'diagnosis').
    usage_task: str | None = None
    max_tokens: int | None = None
    #: user 앞부분(STAGE_TASK_DELIMITER 앞)에 캐시 지점을 둘지(기본 True).
    cache_user: bool = True

    def __post_init__(self) -> None:
        if (self.task is None) == (self.stage is None):
            raise ValueError("task와 stage 중 하나만 주어야 합니다")

    @property
    def label(self) -> str:
        return self.task if self.task is not None else str(self.stage)


@dataclass
class GenerateResult(Generic[T]):
    output: T
    usage: LlmUsage
    model: str
    usage_by_model: list[ModelUsage] | None = None


class LlmClient(Protocol):
    name: str

    async def generate(self, req: LlmRequest) -> GenerateResult[Any]: ...


class LlmPermanentError(Exception):
    """재시도해도 소용없는 실패(거절, 스키마 불일치 반복 등). TS LlmPermanentError와 같은 reason 값."""

    def __init__(self, message: str, reason: PermanentReason, usage: LlmUsage | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.reason: PermanentReason = reason
        self.usage = usage
        self.usage_by_model: list[ModelUsage] | None = None


class UnsupportedProviderError(LlmPermanentError):
    """워커가 실행할 수 없는 엔진(CLI 엔진·알 수 없는 값). 디스패치 단계에서 409로 거절한다."""

    def __init__(self, provider: object) -> None:
        super().__init__(f"워커는 'anthropic' 엔진만 실행합니다(받은 값: {str(provider)[:40]})", "unavailable")
        self.provider = provider


WORKER_PROVIDER = "anthropic"


def assert_worker_provider(provider: object) -> str:
    """작업 행의 provider가 워커에서 실행할 수 있는 값인지(정확히 'anthropic'). 아니면 UnsupportedProviderError."""
    if provider != WORKER_PROVIDER:
        raise UnsupportedProviderError(provider)
    return WORKER_PROVIDER


def usage_of_error(error: BaseException) -> LlmUsage | None:
    u = getattr(error, "usage", None)
    return u if isinstance(u, LlmUsage) else None


def usage_by_model_of_error(error: BaseException) -> list[ModelUsage] | None:
    v = getattr(error, "usage_by_model", None)
    if not isinstance(v, list) or not v or not all(isinstance(x, ModelUsage) for x in v):
        return None
    return v

