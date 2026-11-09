"""경험 그래프 소유자 표시 — 다른 사용자의 그래프가 프롬프트에 섞이지 않게 하는 마지막 확인(심층 방어). TS src/lib/graph/owner.ts와 같은 규칙.

get_career_graph가 읽은 그래프 객체에 요청 user_id를 단다(객체 밖 WeakKeyDictionary — 직렬화에 실리지 않는다).
그래프를 프롬프트에 쓰기 직전에 assert_graph_owner로 작업 행의 user_id와 같은지 본다.
표시는 그 객체에만 붙는다(복사본에는 없다). 표시 없는 그래프(테스트 고정값·복사본)는 통과, 다른 사용자 표시면 막는다.
"""

from __future__ import annotations

import weakref
from typing import TypeVar

T = TypeVar("T")

_owners: weakref.WeakKeyDictionary[object, str] = weakref.WeakKeyDictionary()


class GraphOwnerMismatchError(Exception):
    """그래프 소유자가 요청 사용자와 다르다(버그 — 다른 사용자의 그래프를 쓰려 했다). 작업은 폴백 없이 실패해야 한다."""

    def __init__(self) -> None:
        super().__init__("다른 사용자의 경험 그래프를 쓰려고 했습니다.")


def mark_graph_owner(graph: T, user_id: str) -> T:
    _owners[graph] = user_id
    return graph


def graph_owner_of(graph: object) -> str | None:
    return _owners.get(graph)


def assert_graph_owner(graph: T, user_id: str) -> T:
    owner = _owners.get(graph)
    if owner is not None and owner != user_id:
        raise GraphOwnerMismatchError()
    return graph
