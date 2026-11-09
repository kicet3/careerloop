"""면접 프롬프트가 TS와 글자 하나까지 같은지(tests/fixtures/prompts/interview_*.json — src/lib/interview/prompts.fixtures.test.ts가 만든다)."""

from __future__ import annotations

import pytest

from app.jobs.interview_domain import parse_source_snapshot
from app.prompts.interview import (
    INTERVIEW_FEEDBACK_SYSTEM,
    INTERVIEW_QUESTIONS_SYSTEM,
    build_interview_feedback_prompt,
    build_interview_questions_prompt,
    feedback_context_lines,
)
from tests.conftest import load_fixture

QUESTIONS = load_fixture("prompts/interview_questions.json")
FEEDBACK = load_fixture("prompts/interview_feedback.json")


def test_fixtures_have_cases() -> None:
    assert len(QUESTIONS) >= 5 and any(c["name"] == "injection" for c in QUESTIONS)
    assert len(FEEDBACK) >= 5 and any(c["name"] == "injection" for c in FEEDBACK)


@pytest.mark.parametrize("case", QUESTIONS, ids=[c["name"] for c in QUESTIONS])
def test_questions_prompt_matches_ts(case: dict) -> None:
    snapshot = parse_source_snapshot(case["snapshot"])
    assert snapshot is not None
    system, user = build_interview_questions_prompt(snapshot)
    assert system == case["system"]
    assert user == case["user"]


@pytest.mark.parametrize("case", FEEDBACK, ids=[c["name"] for c in FEEDBACK])
def test_feedback_prompt_matches_ts(case: dict) -> None:
    context = feedback_context_lines(case["question"], case["lines"])
    assert [l["id"] for l in context] == case["contextIds"]
    system, user = build_interview_feedback_prompt(case["question"], case["answer"], case["durationSec"], context)
    assert system == case["system"]
    assert user == case["user"]


def test_system_prompts_are_constant() -> None:
    assert all(c["system"] == INTERVIEW_QUESTIONS_SYSTEM for c in QUESTIONS)
    assert all(c["system"] == INTERVIEW_FEEDBACK_SYSTEM for c in FEEDBACK)


def test_injection_closing_tag_appears_once() -> None:
    case = next(c for c in QUESTIONS if c["name"] == "injection")
    snapshot = parse_source_snapshot(case["snapshot"])
    assert snapshot is not None
    _, user = build_interview_questions_prompt(snapshot)
    assert len(user.split("</interview_sources>")) == 2
    fb = next(c for c in FEEDBACK if c["name"] == "injection")
    _, user = build_interview_feedback_prompt(fb["question"], fb["answer"], fb["durationSec"], feedback_context_lines(fb["question"], fb["lines"]))
    for tag in ("interview_sources", "interview_question", "interview_answer"):
        assert len(user.split(f"</{tag}>")) == 2
