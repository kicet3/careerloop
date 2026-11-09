"""면접 정리 규칙이 TS와 같은지 — TS 기대값(tests/fixtures/prompts/interview_postprocess.json)과 TS 단위 테스트(src/lib/interview/source.test.ts,
service.test.ts '피드백 정리')를 옮긴 사례."""

from __future__ import annotations

import pytest

from app.jobs.interview_domain import (
    InterviewFeatureError,
    estimate_spoken_seconds,
    interview_error_message,
    length_score,
    normalize_facet,
    normalize_generated_questions,
    parse_source_snapshot,
    to_interview_feedback,
    verify_citations,
)
from app.llm.types import LlmPermanentError, UnsupportedProviderError
from tests.conftest import load_fixture

PP = load_fixture("prompts/interview_postprocess.json")


@pytest.mark.parametrize("case", PP["normalize"], ids=[c["name"] for c in PP["normalize"]])
def test_normalize_generated_questions_matches_ts(case: dict) -> None:
    assert normalize_generated_questions(case["output"], case["lines"]) == case["expected"]


@pytest.mark.parametrize("case", PP["verifyCitations"])
def test_verify_citations_matches_ts(case: dict) -> None:
    assert verify_citations(case["raw"], case["lines"]) == case["expected"]


@pytest.mark.parametrize("case", PP["toFeedback"], ids=[c["name"] for c in PP["toFeedback"]])
def test_to_interview_feedback_matches_ts(case: dict) -> None:
    assert to_interview_feedback(case["output"], case["answer"], case["category"], case["lines"]) == case["expected"]


@pytest.mark.parametrize("case", PP["lengthScore"])
def test_length_score_matches_ts(case: dict) -> None:
    assert length_score(case["seconds"], case["range"]) == case["expected"]


@pytest.mark.parametrize("case", PP["spokenSeconds"])
def test_spoken_seconds_matches_ts(case: dict) -> None:
    assert estimate_spoken_seconds(case["text"]) == case["expected"]


@pytest.mark.parametrize("case", PP["snapshotParse"], ids=[c["name"] for c in PP["snapshotParse"]])
def test_snapshot_parse_matches_zod(case: dict) -> None:
    got = parse_source_snapshot(case["raw"])
    if case["ok"]:
        assert got == case["data"]
    else:
        assert got is None


def _error(spec: dict) -> BaseException:
    t = spec["type"]
    if t == "permanent":
        return LlmPermanentError("x", spec["reason"])
    if t == "feature":
        return InterviewFeatureError(spec["message"], 504)
    if t == "timeout":
        return TimeoutError("t")
    return RuntimeError("boom")


@pytest.mark.parametrize("case", PP["errorMessages"])
def test_error_messages_match_ts(case: dict) -> None:
    assert interview_error_message(_error(case["error"]), case["what"]) == case["expected"]


def test_unsupported_provider_is_unavailable_message() -> None:
    msg = interview_error_message(UnsupportedProviderError("claude-cli"), "질문")
    assert msg.startswith("질문을 만들지 못했습니다. 선택한 AI 엔진을 지금 쓸 수 없습니다")


# --- TS 단위 테스트를 옮긴 사례 -------------------------------------------------

LINES = next(c for c in PP["normalize"] if c["name"] == "source_test")["lines"]


def test_verify_citations_ts_case() -> None:
    cs = verify_citations(
        [
            {"ref": "[r5]", "quote": "정산 배치를  Kotlin으로"},
            {"ref": "r5", "quote": "중복"},
            {"ref": "r4", "quote": "p95 900ms"},
            {"ref": "r99", "quote": "없는 줄"},
        ],
        LINES,
    )
    assert cs == [
        {"ref": "r5", "doc": "resume", "quote": "정산 배치를 Kotlin으로", "verified": True},
        {"ref": "r4", "doc": "resume", "quote": "p95 900ms", "verified": False},
    ]


def test_normalize_ts_case() -> None:
    q = lambda **kw: {"category": "line", "facet": "why", "question": "질문", "intent": "", "citations": [], "followUps": [], **kw}  # noqa: E731
    out = {
        "questions": [
            q(question="왜 재작성했나요?", intent="필요성", citations=[{"ref": "r5", "quote": "정산 배치"}], followUps=["  누가 정했나요? ", ""]),
            q(question="왜  재작성했나요?", intent="중복", citations=[{"ref": "r5", "quote": "정산"}]),
            q(category="pivot", facet="Z", question="지표는?", citations=[{"ref": "r4", "quote": "p95"}]),
            q(category="tough", facet="number", question="근거 없는 질문", citations=[{"ref": "r99", "quote": "x"}]),
            q(category="project", facet="result", question="지어낸 인용 질문", citations=[{"ref": "r5", "quote": "트래픽 10배 대응"}]),
            q(question="빈 인용 질문", citations=[{"ref": "r4", "quote": "x없는말"}, {"ref": "r5", "quote": ""}]),
            q(category="job", facet="why", question="이 직무에서 중요한 것은?"),
        ],
        "notes": [],
    }
    qs = normalize_generated_questions(out, LINES)
    assert [(x["category"], x["facet"], x["question"]) for x in qs] == [
        ("line", "why", "왜 재작성했나요?"),
        ("pivot", None, "지표는?"),
        ("line", "why", "빈 인용 질문"),
        ("job", None, "이 직무에서 중요한 것은?"),
    ]
    assert [(c["ref"], c["verified"]) for c in qs[2]["citations"]] == [("r5", True), ("r4", False)]
    assert qs[0]["followUps"] == ["누가 정했나요?"]
    assert normalize_facet("pivot", "O") == "O"


def test_spoken_seconds_ts_case() -> None:
    assert estimate_spoken_seconds("가" * 150 + "   ") == 30


def _feedback_out(**over: object) -> dict:
    base = {
        "overall": 140,
        "criteria": {
            "evidence": {"score": 9, "comment": " 근거 "},
            "numbers": {"score": 0, "comment": ""},
            "ownership": {"score": 3, "comment": ""},
            "length": {"score": 1, "comment": "LLM 평"},
            "structure": {"score": 3, "comment": ""},
        },
        "strengths": ["a", " ", "b"],
        "improvements": [],
        "unsupportedClaims": [],
        "modelAnswer": {"conclusion": "결론", "points": [{"text": "근거", "ref": "r1"}, {"text": "없는 줄", "ref": "r99"}, {"text": "[ADD: 기간]", "ref": None}], "limitation": ""},
        "followUp": "“다음?”",
    }
    base.update(over)
    return base


def test_to_feedback_ts_case() -> None:
    answer = "가" * 250
    f = to_interview_feedback(_feedback_out(), answer, "line", [{"id": "r1", "doc": "resume", "label": "l", "path": None, "text": "t"}])
    assert f["overall"] == 100
    assert f["criteria"]["evidence"]["score"] == 5
    assert f["criteria"]["numbers"]["score"] == 1
    assert f["criteria"]["length"] == {"score": 5, "comment": "약 50초 분량(권장 30~90초). LLM 평"}
    assert [p["ref"] for p in f["modelAnswer"]["points"]] == ["r1", None, None]
    assert f["strengths"] == ["a", "b"]
    assert f["followUp"] == "다음?"
    crit = dict(_feedback_out()["criteria"])  # type: ignore[arg-type]
    crit["length"] = {"score": 2, "comment": "약 50초로 적당합니다."}
    g = to_interview_feedback(_feedback_out(criteria=crit), answer, "line")
    assert g["criteria"]["length"] == {"score": 5, "comment": "약 50초로 적당합니다."}
    assert f["answerChars"] == 250 and f["estimatedSeconds"] == 50 and f["recommendedSeconds"] == {"min": 30, "max": 90}


def test_length_score_ts_case() -> None:
    r = {"min": 30, "max": 90}
    assert [length_score(s, r) for s in (60, 25, 10, 200, 0)] == [5, 4, 2, 2, 1]
