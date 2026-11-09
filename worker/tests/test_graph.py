"""경험 그래프 포팅 — TS가 만든 fixtures/graph.json과 글자 하나까지 같은지 + 소유자 격리."""

from __future__ import annotations

import copy

import pytest

from app.graph import (
    CareerGraph,
    GraphOwnerMismatchError,
    assert_graph_owner,
    build_career_graph,
    graph_owner_of,
    graph_to_text,
    mark_graph_owner,
    to_graph_node,
)
from app.graph.dates import normalize_stored_dates, parse_graph_date
from app.jsutil import js_len, js_slice
from tests.conftest import load_fixture

G = load_fixture("graph.json")


def test_graph_to_text_matches_typescript() -> None:
    graph = CareerGraph.from_dict(G["graph"])
    for c in G["textCases"]:
        o = c["opts"]
        assert graph_to_text(graph, max_chars=o.get("maxChars"), prop_caps=o.get("propCaps")) == c["text"], o
    assert graph_to_text(CareerGraph()) == G["emptyText"]


def test_parse_graph_date_matches_typescript() -> None:
    for c in G["parseGraphDate"]:
        assert parse_graph_date(c["raw"]) == c["result"], c["raw"]


def test_normalize_stored_dates_matches_typescript() -> None:
    for c in G["normalizeStoredDates"]:
        got = normalize_stored_dates(c["label"], c["props"])
        assert got == c["result"], c
        assert list(got) == list(c["result"]), c  # 키 순서까지(텍스트 출력 순서가 된다)


def test_to_graph_node_matches_typescript() -> None:
    for c in G["toGraphNode"]:
        node = to_graph_node(c["id"], c["label"], c["raw"])
        assert node.to_dict() == c["node"]
        assert list(node.props) == list(c["node"]["props"])


def test_js_string_helpers() -> None:
    assert js_len("a😀") == 3
    assert js_slice("가😀나", 0, 2) == "가\ud83d"
    assert js_slice("abc", 0, 10) == "abc"


# --- 격리 ------------------------------------------------------------------


def _rows(user_id: str) -> list[dict]:
    return [
        {"id": "n1", "label": "Company", "props": {"id": "n1", "userId": user_id, "name": "A", "createdAt": 1}},
        {"id": "n2", "label": "Skill", "props": {"id": "n2", "userId": user_id, "name": "Go"}},
    ]


def test_build_graph_marks_owner_and_drops_foreign_edges() -> None:
    g = build_career_graph(
        "u1",
        _rows("u1"),
        [
            {"type": "WORKED_AT", "from": "me", "to": "n1"},
            {"type": "HAS_SKILL", "from": "me", "to": "n2"},
            {"type": "USED_SKILL", "from": "other-user-node", "to": "n2"},
            {"type": "NOT_A_REL", "from": "me", "to": "n1"},
        ],
    )
    assert graph_owner_of(g) == "u1"
    assert [e.id for e in g.edges] == ["WORKED_AT:me:n1", "HAS_SKILL:me:n2"]
    assert "userId" not in g.nodes[0].props  # 화이트리스트 밖 시스템 키는 프롬프트에 실리지 않는다
    assert_graph_owner(g, "u1")
    with pytest.raises(GraphOwnerMismatchError):
        assert_graph_owner(g, "u2")


def test_foreign_node_in_result_rejects_whole_graph() -> None:
    rows = _rows("u1") + [{"id": "x", "label": "Company", "props": {"id": "x", "userId": "u2", "name": "남의 회사"}}]
    with pytest.raises(GraphOwnerMismatchError):
        build_career_graph("u1", rows, [])
    with pytest.raises(GraphOwnerMismatchError):
        build_career_graph("u1", [{"id": "y", "label": "Company", "props": {"name": "userId 없음"}}], [])


def test_owner_mark_is_per_object() -> None:
    g = mark_graph_owner(CareerGraph(), "u1")
    assert graph_owner_of(copy.copy(g)) is None  # 복사본에는 표시가 없다(TS WeakMap과 같다)
    assert_graph_owner(CareerGraph(), "anyone")  # 표시 없는 고정값은 통과
    with pytest.raises(ValueError):
        build_career_graph("", [], [])
