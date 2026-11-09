"""resume-draft: TS와 글자 하나까지 같은지(프롬프트·후처리·입력 검증). fixture는 TS src/lib/resumes/draft-prompt-fixtures.test.ts가 만든다."""

from __future__ import annotations

import json

import pytest

from app.jobs.resume_draft_output import RESUME_DRAFT_OUTPUT_SCHEMA, parse_create_resume_input, postprocess_draft
from app.prompts.resume_draft import SYSTEM, DraftContext, DraftMaterial, build_resume_draft_prompt, draft_context_for
from tests.conftest import load_fixture

PROMPTS = load_fixture("prompts/resume-draft.json")
POST = load_fixture("prompts/resume-draft-postprocess.json")


def _material(m: dict) -> DraftMaterial:
    return DraftMaterial(m["kind"], m["text"], m.get("diagnosisTitle", ""))


def _ordered(v: object) -> str:
    """키 순서까지 비교하려고 JSON 문자열로."""
    return json.dumps(v, ensure_ascii=False)


@pytest.mark.parametrize("case", PROMPTS, ids=[c["name"] for c in PROMPTS])
def test_prompt_is_byte_identical(case: dict) -> None:
    ctx = draft_context_for(case["user"], case["input"], _material(case["material"]))
    system, user = build_resume_draft_prompt(ctx)
    assert system == case["system"]
    assert user == case["prompt"]


def test_fixture_covers_injection_and_all_templates() -> None:
    assert {c["input"]["templateId"] for c in PROMPTS} >= {"performance", "classic", "modern", "compact", "developer", "career-change"}
    first = next(c for c in PROMPTS if c["name"] == "company-graph-modern-injection")["prompt"]
    assert first.count("</career_graph>") == 1
    assert first.count("</job_posting>") == 1
    assert "‹/CAREER_GRAPH" in first  # 대소문자 섞인 닫는 태그도 무력화
    assert "<reſume>" in first  # JS i 플래그는 ASCII만 접는다 — 'ſ'는 그대로
    assert SYSTEM == PROMPTS[0]["system"]


@pytest.mark.parametrize("case", POST["postprocess"], ids=[c["name"] for c in POST["postprocess"]])
def test_output_schema_and_postprocess_match_ts(case: dict) -> None:
    ok, value = RESUME_DRAFT_OUTPUT_SCHEMA.parse(case["output"])
    assert ok == case["ok"], value
    if not ok:
        return
    ctx = DraftContext("c", "r", "", "classic", DraftMaterial("graph", "g"), person_name=case["personName"], person_email=case["personEmail"])
    draft = postprocess_draft(value, ctx)
    assert draft == case["draft"]
    assert _ordered(draft) == _ordered(case["draft"])


@pytest.mark.parametrize("case", POST["inputs"], ids=[c["name"] for c in POST["inputs"]])
def test_create_resume_input_matches_zod(case: dict) -> None:
    parsed = parse_create_resume_input(case["raw"])
    assert parsed == case["parsed"]
    if parsed is not None:
        assert _ordered(parsed) == _ordered(case["parsed"])


def test_postprocess_does_not_mutate_input() -> None:
    case = next(c for c in POST["postprocess"] if c["name"] == "extras-merge-trivial")
    ok, value = RESUME_DRAFT_OUTPUT_SCHEMA.parse(case["output"])
    assert ok
    before = json.dumps(value, ensure_ascii=False)
    postprocess_draft(value, DraftContext("c", "r", "", "classic", DraftMaterial("graph", "g")))
    assert json.dumps(value, ensure_ascii=False) == before
