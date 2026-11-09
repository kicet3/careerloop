"""외톨이 서로게이트(js_slice가 이모지를 가를 때 남는다)가 밖으로 나가는 모든 경로(LLM 요청 본문·DB 문자열·저장소)에서 U+FFFD로 바뀌는지.

Python은 외톨이 서로게이트를 UTF-8로 인코딩하지 못해(UnicodeEncodeError) 작업이 매번 실패한다. Node는 JSON.stringify가 이스케이프하고
Buffer.from이 U+FFFD로 바꿔 보내므로, 같은 결과(U+FFFD)로 맞춘다.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.jobs import portfolio_graph_store, resume_draft_resumes
from app.jsutil import js_slice, well_formed, well_formed_deep
from app.llm.anthropic_client import AnthropicLlmClient
from app.storage import Storage
from tests.test_anthropic_client import SCHEMA, FakeSdk, _msg

HALF = js_slice("가" * 59 + "😀", 0, 60)  # 이모지 앞 절반(\ud83d)만 남는다


def test_js_slice_leaves_lone_surrogate_and_well_formed_fixes_it() -> None:
    assert HALF.endswith("\ud83d")
    try:
        HALF.encode("utf-8")
        raise AssertionError("외톨이 서로게이트는 UTF-8로 인코딩되면 안 된다")
    except UnicodeEncodeError:
        pass
    assert well_formed(HALF) == "가" * 59 + "�"
    # 짝이 맞는 이모지·한글은 그대로
    assert well_formed("😀 가") == "😀 가"
    assert well_formed_deep({"k\udc00": ["a\ud83d", 1, None, ("\udfff",)]}) == {"k�": ["a�", 1, None, ("�",)]}


async def test_anthropic_request_body_is_well_formed() -> None:
    from app.llm.types import LlmRequest

    # 첫 응답은 스키마에 맞지 않아 재요청(assistant 메시지 포함)도 확인한다.
    sdk = FakeSdk([_msg('{"answer": 1}'), _msg('{"answer":"좋음"}')])
    req = LlmRequest(system=f"SYS{HALF}", user=f"자료{HALF}\n<<<STAGE_TASK>>>\n할 일{HALF}", schema=SCHEMA, effort="high", task="resume-draft")
    await AnthropicLlmClient(sdk).generate(req)  # type: ignore[arg-type]
    for p in sdk.params:
        # SDK가 본문을 만드는 방식(ensure_ascii=False → UTF-8)으로 인코딩해도 실패하지 않는다.
        json.dumps(p, ensure_ascii=False).encode("utf-8")
        assert "\ud83d" not in json.dumps(p, ensure_ascii=False)
    assert sdk.params[0]["system"][0]["text"] == "SYS" + "가" * 59 + "�"
    assert sdk.params[0]["messages"][0]["content"][0]["text"] == "자료" + "가" * 59 + "�"


def test_store_strip_nul_replaces_lone_surrogates() -> None:
    assert resume_draft_resumes.strip_nul(f"a\u0000{HALF}") == "a" + "가" * 59 + "�"
    assert resume_draft_resumes.strip_nul(None) is None
    assert resume_draft_resumes.strip_nul_deep({"t": [HALF]}) == {"t": ["가" * 59 + "�"]}
    assert portfolio_graph_store.strip_nul(f"b\u0000{HALF}") == "b" + "가" * 59 + "�"
    assert portfolio_graph_store.strip_nul_deep({HALF: HALF}) == {"가" * 59 + "�": "가" * 59 + "�"}
    # 다시 생성 기본 제목(회사+직무 120자 자르기)도 UTF-8로 쓸 수 있다.
    title = resume_draft_resumes.strip_nul(js_slice("가" * 119 + "😀", 0, 120))
    assert title is not None
    title.encode("utf-8")


async def test_storage_put_json_and_put_object_are_surrogate_safe(tmp_path: Path) -> None:
    storage = Storage(production=False, env={"STORAGE_DIR": str(tmp_path)})
    # TS가 쓴 JSON의 "\ud83d" 이스케이프를 읽으면 Python str에 외톨이 서로게이트가 생긴다 — 그대로 다시 저장해도 실패하지 않는다.
    doc = json.loads('{"summary":"\\ud83d 요약"}')
    await storage.put_json("users/u1/resumes/r1/v1.json", doc)
    assert await storage.get_json("users/u1/resumes/r1/v1.json") == {"summary": "� 요약"}
    await storage.put_object("users/u1/portfolios/p1/body.md", HALF, "text/markdown; charset=utf-8")
    raw = await storage.get_object("users/u1/portfolios/p1/body.md")
    assert raw is not None and raw.decode("utf-8") == "가" * 59 + "�"
