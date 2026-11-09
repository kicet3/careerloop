"""LLM 계층 포팅 — TS가 만든 fixtures/llm_contract.json·pricing.json과 같은지."""

from __future__ import annotations

import json

from app.llm.anthropic_client import DEFAULT_MODEL, STAGE_TASK_DELIMITER, add_usage, add_usage_by_model, schema_instruction, user_content
from app.llm.pricing import MODEL_PRICES, estimate_cost_by_model, estimate_cost_micro_usd, price_for
from app.llm.schemas import load_output_schema, to_strict_json_schema
from app.llm.types import LlmUsage, ModelUsage
from tests.conftest import load_fixture

C = load_fixture("llm_contract.json")
P = load_fixture("pricing.json")


def test_constants() -> None:
    assert DEFAULT_MODEL == C["defaultModel"]
    assert STAGE_TASK_DELIMITER == C["stageTaskDelimiter"]


def test_strict_schema_matches_typescript_byte_for_byte() -> None:
    for name, expected in C["strict"].items():
        schema = load_output_schema(name)
        assert schema.strict == expected, name
        # 키 순서까지 같아야 schema_instruction·프롬프트 캐시가 같다.
        assert json.dumps(schema.strict, ensure_ascii=False) == json.dumps(expected, ensure_ascii=False), name
        assert schema_instruction(schema) == C["schemaInstruction"][name], name
    edge = C["strictEdge"]
    assert json.dumps(to_strict_json_schema(edge["raw"]), ensure_ascii=False) == json.dumps(edge["strict"], ensure_ascii=False)


def test_user_content_matches_typescript() -> None:
    for c in C["userContent"]:
        assert user_content(c["user"], c["cache"]) == c["blocks"], c


def _usage(d: dict) -> LlmUsage:
    return LlmUsage.from_dict(d)


def test_usage_accumulation_matches_typescript() -> None:
    acc = LlmUsage()
    by: list[ModelUsage] = []
    req = C["usage"]["requestedModel"]
    for step in C["usage"]["steps"]:
        acc = add_usage(acc, step["message"])
        by = add_usage_by_model(by, step["message"], req)
        assert acc.to_dict() == step["usage"]
        assert [m.to_dict() for m in by] == step["usageByModel"]


def test_price_table_matches_typescript() -> None:
    assert set(MODEL_PRICES) == set(P["prices"])
    for k, p in P["prices"].items():
        mine = MODEL_PRICES[k]
        assert (mine.input, mine.output, mine.cache_read, mine.cache_write) == (p["input"], p["output"], p["cacheRead"], p["cacheWrite"]), k


def test_cost_estimates_match_typescript() -> None:
    for c in P["cases"]:
        p = price_for(c["model"])
        assert (p is None) == (c["price"] is None), c["model"]
        assert estimate_cost_micro_usd(c["model"], _usage(c["usage"])) == c["cost"], c["model"]
    for c in P["byModel"]:
        parts = [ModelUsage(x["model"], _usage(x["usage"])) for x in c["parts"]]
        assert estimate_cost_by_model(parts) == c["cost"]


def test_generated_schemas_validate() -> None:
    s = load_output_schema("interview_questions_output")
    ok, problem = s.parse({})
    assert not ok and "(root)" in problem
