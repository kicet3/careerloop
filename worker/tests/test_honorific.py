"""경어체 통일(app/honorific.py)이 TS src/lib/resumes/honorific.ts와 글자 하나까지 같은지. fixture는 TS honorific.test.ts가 만든다."""

from __future__ import annotations

import json

import pytest

from app.honorific import HONORIFIC_RULE, honorific_leftover_note, normalize_document_honorific, normalize_honorific
from app.prompts.resume_draft import RESUME_WRITING_CRITERIA_PROMPT, SYSTEM
from tests.conftest import load_fixture

FIX = load_fixture("honorific.json")


def test_rule_matches_ts_and_is_in_prompt() -> None:
    assert HONORIFIC_RULE == FIX["rule"]
    assert f"- {HONORIFIC_RULE}" in RESUME_WRITING_CRITERIA_PROMPT
    assert HONORIFIC_RULE in SYSTEM


@pytest.mark.parametrize("case", FIX["texts"], ids=[str(i) for i in range(len(FIX["texts"]))])
def test_normalize_text_matches_ts(case: dict) -> None:
    r = normalize_honorific(case["input"])
    assert r.text == case["text"]
    assert r.leftovers == case["leftovers"]
    assert r.changed == case["changed"]


def test_normalize_document_matches_ts() -> None:
    case = FIX["document"]
    before = json.dumps(case["input"], ensure_ascii=False)
    r = normalize_document_honorific(case["input"])
    assert json.dumps(case["input"], ensure_ascii=False) == before  # 입력은 바꾸지 않는다
    assert json.dumps(r.document, ensure_ascii=False) == json.dumps(case["document"], ensure_ascii=False)
    assert r.changed == case["changed"]
    assert r.leftovers == case["leftovers"]
    assert honorific_leftover_note(r.leftovers) == "문장 끝을 '~습니다'로 자동으로 바꾸지 못한 문장 1개가 있습니다. 직접 확인해 주세요: '담당은 개발자다'"
    assert honorific_leftover_note([]) is None
