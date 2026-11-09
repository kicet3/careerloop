"""경험 그래프 계약(TS src/lib/domain/graph.ts). 라벨·관계·속성 키 표는 TS에서 생성한 schemas/generated/graph_domain.json을 읽는다
(손으로 옮기지 않는다 — TS를 고치면 fixtures 테스트가 다시 만들라고 알린다).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_DOMAIN = json.loads((Path(__file__).resolve().parent.parent / "schemas" / "generated" / "graph_domain.json").read_text("utf-8"))

PERSON_ID: str = _DOMAIN["personId"]
NODE_LABELS: tuple[str, ...] = tuple(_DOMAIN["nodeLabels"])
NODE_LABEL_META: dict[str, dict[str, str]] = _DOMAIN["labelMeta"]
NODE_TITLE_KEY: dict[str, str] = _DOMAIN["titleKey"]
REL_TYPES: tuple[str, ...] = tuple(_DOMAIN["relTypes"])
REL_NAMES: dict[str, str] = _DOMAIN["relNames"]
_PROP_KEYS: dict[str, list[str]] = _DOMAIN["propKeys"]


def is_label(v: object) -> bool:
    return isinstance(v, str) and v in NODE_LABELS


def is_rel(v: object) -> bool:
    return isinstance(v, str) and v in REL_TYPES


def allowed_prop_keys(label: str) -> list[str]:
    """노드 1개당 속성 키 화이트리스트(스키마 순서)."""
    return list(_PROP_KEYS[label])


def edge_id(type_: str, from_: str, to: str) -> str:
    return f"{type_}:{from_}:{to}"


@dataclass(eq=False)
class GraphNode:
    id: str
    label: str
    props: dict[str, Any]
    created_at: int | float = 0
    updated_at: int | float = 0

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "props": self.props, "createdAt": self.created_at, "updatedAt": self.updated_at}


@dataclass(eq=False)
class GraphEdge:
    id: str
    type: str
    from_: str
    to: str

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "type": self.type, "from": self.from_, "to": self.to}


@dataclass(eq=False)
class GraphPerson:
    id: str = PERSON_ID
    name: str | None = None


@dataclass(eq=False)
class CareerGraph:
    """eq=False — 소유자 표시(owner.py)가 객체 정체성에 붙으므로 값 비교·해시를 쓰지 않는다."""

    person: GraphPerson = field(default_factory=GraphPerson)
    nodes: list[GraphNode] = field(default_factory=list)
    edges: list[GraphEdge] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "person": {"id": self.person.id, "name": self.person.name},
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [e.to_dict() for e in self.edges],
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> CareerGraph:
        """테스트·고정값용(소유자 표시 없음)."""
        p = d.get("person") or {}
        return CareerGraph(
            person=GraphPerson(id=p.get("id", PERSON_ID), name=p.get("name")),
            nodes=[GraphNode(n["id"], n["label"], dict(n.get("props") or {}), n.get("createdAt", 0), n.get("updatedAt", 0)) for n in d.get("nodes", [])],
            edges=[GraphEdge(e["id"], e["type"], e["from"], e["to"]) for e in d.get("edges", [])],
        )


def node_display_name(node: GraphNode) -> str:
    v = node.props.get(NODE_TITLE_KEY[node.label])
    return v if isinstance(v, str) and v else NODE_LABEL_META[node.label]["name"]
