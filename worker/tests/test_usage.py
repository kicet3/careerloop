"""사용량 기록 — TS usage.ts와 같은 열 값·같은 기록 규칙."""

from __future__ import annotations

import asyncio

import pytest

from app.llm.factory import LlmFactory, UnavailableLlmClient
from app.llm.schemas import OutputSchema
from app.llm.types import LlmPermanentError, LlmRequest, LlmUsage, ModelUsage, UnsupportedProviderError
from app.llm.usage import LlmUsageContext, LlmUsageEvent, UsageRecordingLlmClient, db_usage_recorder, usage_row
from tests.fake_llm import FakeLlmClient
from tests.fakes import FakeDb

SCHEMA = OutputSchema("t", {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]})


def _req(task: str | None = "interview-questions", **kw) -> LlmRequest:
    return LlmRequest(system="s", user="u" * 9, schema=SCHEMA, effort="low", task=task, **kw)


def _client(inner, events: list) -> UsageRecordingLlmClient:
    async def record(e: LlmUsageEvent) -> None:
        events.append(e)

    return UsageRecordingLlmClient(inner, provider="anthropic", model="claude-opus-5-5", ctx=LlmUsageContext("u1", "ref1"), record=record)


async def test_records_success() -> None:
    events: list[LlmUsageEvent] = []
    r = await _client(FakeLlmClient({"interview-questions": lambda req: {"a": "x"}}), events).generate(_req())
    assert r.output == {"a": "x"}
    [e] = events
    assert (e.user_id, e.reference_id, e.task, e.stage, e.ok, e.model) == ("u1", "ref1", "interview-questions", None, True, "fake")
    assert e.usage.input_tokens == 4 and e.usage.output_tokens == 800


async def test_records_failure_with_partial_usage() -> None:
    err = LlmPermanentError("x", "invalid_output", LlmUsage(10, 2, 0, 0))
    err.usage_by_model = [ModelUsage("claude-opus-5-5", LlmUsage(10, 2, 0, 0))]
    events: list[LlmUsageEvent] = []
    with pytest.raises(LlmPermanentError):
        await _client(FakeLlmClient(errors={"interview-questions": err}), events).generate(_req())
    [e] = events
    assert not e.ok and e.error_reason == "invalid_output" and e.usage.input_tokens == 10 and e.model == "claude-opus-5-5"


async def test_stage_request_defaults_to_diagnosis_task() -> None:
    events: list[LlmUsageEvent] = []
    req = LlmRequest(system="s", user="u", schema=SCHEMA, effort="low", stage="jd")
    await _client(FakeLlmClient({"jd": lambda r: {"a": "1"}}), events).generate(req)
    assert (events[0].task, events[0].stage) == ("diagnosis", "jd")


async def test_unavailable_without_usage_is_not_recorded() -> None:
    events: list[LlmUsageEvent] = []
    with pytest.raises(LlmPermanentError):
        await _client(UnavailableLlmClient("no key"), events).generate(_req())
    assert events == []


async def test_cancel_records_aborted() -> None:
    events: list[LlmUsageEvent] = []
    client = _client(FakeLlmClient({"interview-questions": lambda r: {"a": "x"}}, delay_sec=1), events)
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(0.01):
            await client.generate(_req())
    assert events and events[0].error_reason == "aborted"


def test_usage_row_matches_typescript_columns() -> None:
    row = usage_row(
        LlmUsageEvent(
            user_id="u1",
            task="t" * 70,
            stage=None,
            provider="anthropic",
            model="claude-opus-5-5",
            usage=LlmUsage(1_000_000, 2.5, -3, 2**40),  # type: ignore[arg-type]
            ok=False,
            error_reason=None,
            reference_id="r",
        )
    )
    assert list(row) == [
        "user_id",
        "task",
        "stage",
        "provider",
        "model",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "cost_micro_usd",
        "ok",
        "error_reason",
        "reference_id",
    ]
    assert len(row["task"]) == 64
    assert (row["input_tokens"], row["output_tokens"], row["cache_read_tokens"], row["cache_write_tokens"]) == (1_000_000, 3, 0, 2_147_483_647)
    assert row["error_reason"] == "error"
    cli = usage_row(LlmUsageEvent("u", "t", None, "claude-cli", "m", LlmUsage(1, 1), True))
    assert cli["cost_micro_usd"] is None and cli["error_reason"] is None


async def test_db_recorder_inserts_and_swallows_errors() -> None:
    db = FakeDb(lambda sql, params: 1)
    await db_usage_recorder(db)(LlmUsageEvent("u", "t", None, "anthropic", "claude-opus-5-5", LlmUsage(1, 1), True))
    sql, params = db.calls[0]
    assert sql.startswith("INSERT INTO llm_usage_events") and params["cost_micro_usd"] == 24

    def boom(sql, params):
        raise RuntimeError("db down")

    await db_usage_recorder(FakeDb(boom))(LlmUsageEvent("u", "t", None, "anthropic", "m", LlmUsage(), True))


def test_factory_rejects_cli_providers() -> None:
    async def record(e) -> None: ...

    f = LlmFactory(api_key="k", model=None, record=record)
    for p in ["claude-cli", "codex-cli", None, "mock", "ANTHROPIC"]:
        with pytest.raises(UnsupportedProviderError):
            f.create(p, LlmUsageContext("u"))
    assert isinstance(f.create("anthropic", LlmUsageContext("u")), UsageRecordingLlmClient)
    assert isinstance(LlmFactory(api_key=None, model=None, record=record).create("anthropic", LlmUsageContext("u")), UnavailableLlmClient)
