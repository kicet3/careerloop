"""'portfolio-graph' TS 일치 확인 — src/lib/portfolios/graph-worker-fixtures.test.ts가 만든 fixture와 Python 결과가 글자 하나까지 같은지.

TS를 고치고 fixture를 다시 만들었는데 Python을 고치지 않았으면 여기서 실패한다.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.graph.domain import CareerGraph
from app.jobs.portfolio_graph_material import OwnPosting, PortfolioMaterial, PortfolioProjectMaterial, per_project_max_chars, project_text
from app.jobs.portfolio_graph_output import (
    PortfolioJobError,
    count_portfolio_add_markers,
    graph_portfolio_error_message,
    graph_portfolio_to_markdown,
    parse_start_input,
    sanitize_portfolio_output,
    unverified_numbers,
)
from app.llm.types import LlmPermanentError
from app.prompts.portfolio_graph import build_graph_portfolio_prompt
from tests.conftest import load_fixture

PROMPTS = load_fixture("prompts/portfolio-graph.json")
MATERIAL = load_fixture("prompts/portfolio-graph-material.json")
POST = load_fixture("prompts/portfolio-graph-postprocess.json")


def to_material(m: dict[str, Any]) -> PortfolioMaterial:
    p = m.get("posting")
    return PortfolioMaterial(
        person_name=m["personName"],
        projects=[PortfolioProjectMaterial(id=x["id"], name=x["name"], text=x["text"]) for x in m["projects"]],
        links={k: v for k, v in m["links"]},
        contact_links=m["contactLinks"],
        posting=OwnPosting(id="", company=p["company"], role_title=p["roleTitle"], jd_text=p["jdText"]) if p else None,
    )


@pytest.mark.parametrize("case", PROMPTS, ids=[c["name"] for c in PROMPTS])
def test_prompt_is_byte_identical(case: dict[str, Any]) -> None:
    opts = case["opts"]
    system, user = build_graph_portfolio_prompt(to_material(case["material"]), title=opts["title"], notes=opts.get("notes"), template_id=opts.get("templateId"))
    assert system == case["system"]
    assert user == case["user"]


def test_prompt_cases_cover_injection_and_every_template() -> None:
    names = [c["name"] for c in PROMPTS]
    assert any(n.startswith("인젝션") for n in names)
    assert sum(n.startswith("양식 ") for n in names) == 6


@pytest.mark.parametrize("case", MATERIAL["projectText"], ids=lambda c: f"{c['projectId']}-{c['maxChars']}")
def test_project_text_is_byte_identical(case: dict[str, Any]) -> None:
    graph = CareerGraph.from_dict(MATERIAL["graph"])
    assert project_text(graph, case["projectId"], case["maxChars"]) == case["text"]


def test_per_project_chars() -> None:
    for c in MATERIAL["perProject"]:
        assert per_project_max_chars(c["count"]) == c["chars"]


@pytest.mark.parametrize("case", POST["sanitize"], ids=[c["name"] for c in POST["sanitize"]])
def test_sanitize_matches_ts(case: dict[str, Any]) -> None:
    assert sanitize_portfolio_output(case["output"], to_material(case["material"]), case["templateId"]) == case["result"]


@pytest.mark.parametrize("case", POST["markdown"], ids=[c["name"] for c in POST["markdown"]])
def test_markdown_is_byte_identical(case: dict[str, Any]) -> None:
    o = case["opts"]
    md = graph_portfolio_to_markdown(
        case["output"],
        title=o["title"],
        person_name=o.get("personName"),
        links={k: v for k, v in o["links"]} if o.get("links") else None,
        contact_links=o.get("contactLinks"),
        template_id=o.get("templateId"),
    )
    assert md == case["markdown"]


def test_numbers_and_markers() -> None:
    for c in POST["numbers"]:
        assert unverified_numbers(c["text"], c["source"]) == c["result"], c
    for c in POST["addMarkers"]:
        assert count_portfolio_add_markers(c["text"]) == c["count"], c


@pytest.mark.parametrize("case", POST["input"], ids=lambda c: str(c["raw"])[:40])
def test_start_input_matches_zod(case: dict[str, Any]) -> None:
    assert parse_start_input(case["raw"]) == case["parsed"]


@pytest.mark.parametrize("case", POST["errors"], ids=[c["name"] for c in POST["errors"]])
def test_error_messages_match_ts(case: dict[str, Any]) -> None:
    err: BaseException
    if case["kind"] == "permanent":
        err = LlmPermanentError("x", case["reason"])
    elif case["kind"] == "feature":
        err = PortfolioJobError("고른 프로젝트 중 내 경험 그래프에 없는 항목이 있습니다.", 400)
    elif case["kind"] == "timeout":
        err = TimeoutError()
    else:
        err = RuntimeError("boom")
    assert graph_portfolio_error_message(err) == case["message"]
