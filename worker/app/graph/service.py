"""경험 그래프 읽기 — TS src/lib/graph/service.ts getCareerGraph·toGraphNode(src/lib/graph/node.ts)를 옮긴 것.

격리 규칙(코드로 강제한다):
- 모든 MATCH에 userId 조건을 건다. user_id는 호출자가 DB 작업 행에서 읽은 값만 넘긴다(요청 본문 값 금지).
- 심층 방어: 쿼리가 다른 사용자 노드를 돌려주면(쿼리 회귀) 그래프 전체를 버리고 GraphOwnerMismatchError — 폴백 없이 작업을 실패시킨다.
- 돌려준 그래프 객체에 소유자를 단다(mark_graph_owner). 프롬프트에 쓰기 직전 assert_graph_owner(graph, job.user_id)로 확인한다.
"""

from __future__ import annotations

from typing import Any

from neo4j import AsyncManagedTransaction, unit_of_work

from app.graph.client import GraphClient
from app.graph.dates import normalize_stored_dates
from app.graph.domain import PERSON_ID, CareerGraph, GraphEdge, GraphNode, GraphPerson, allowed_prop_keys, edge_id, is_label, is_rel
from app.graph.owner import GraphOwnerMismatchError, mark_graph_owner

_NODES_CYPHER = """MATCH (n:Career {userId: $userId})
         RETURN n.id AS id, [l IN labels(n) WHERE l <> 'Career'][0] AS label, properties(n) AS props
         ORDER BY n.createdAt, n.id"""
_EDGES_CYPHER = """MATCH (a)-[r]->(b:Career {userId: $userId})
         WHERE (a:Career OR a:Person) AND a.userId = $userId
         RETURN type(r) AS type, CASE WHEN a:Person THEN $person ELSE a.id END AS from, b.id AS to"""


def _num(v: Any) -> int | float:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def to_graph_node(node_id: str, label: str, raw: dict[str, Any]) -> GraphNode:
    """저장된 노드 → GraphNode(화이트리스트 키만, 옛 형식 날짜는 읽을 때 정규화). TS toGraphNode와 같다."""
    picked = {k: raw[k] for k in allowed_prop_keys(label) if raw.get(k) is not None}
    props = normalize_stored_dates(label, picked)
    return GraphNode(node_id, label, props, _num(raw.get("createdAt")), _num(raw.get("updatedAt")))


def _assert_user_id(user_id: str) -> None:
    if not user_id or not isinstance(user_id, str):
        raise ValueError("user_id가 필요합니다")


def build_career_graph(user_id: str, node_rows: list[dict[str, Any]], edge_rows: list[dict[str, Any]], person_name: str | None = None) -> CareerGraph:
    """쿼리 결과 → 소유자를 단 CareerGraph(순수 — 격리 테스트가 직접 부른다)."""
    _assert_user_id(user_id)
    nodes: list[GraphNode] = []
    for r in node_rows:
        props = r.get("props") or {}
        if props.get("userId") != user_id:
            raise GraphOwnerMismatchError()
        label = r.get("label")
        if is_label(label):
            nodes.append(to_graph_node(r["id"], label, props))
    ids = {n.id for n in nodes}
    edges: list[GraphEdge] = []
    for r in edge_rows:
        t, f, to = r.get("type"), r.get("from"), r.get("to")
        if not is_rel(t) or to not in ids or (f != PERSON_ID and f not in ids):
            continue
        edges.append(GraphEdge(edge_id(t, f, to), t, f, to))
    return mark_graph_owner(CareerGraph(GraphPerson(PERSON_ID, person_name), nodes, edges), user_id)


async def get_career_graph(graph: GraphClient, user_id: str, person_name: str | None = None) -> CareerGraph:
    """사용자의 경험 그래프 스냅샷(소유자 표시 포함). 읽기 트랜잭션 타임아웃 5초(TS와 같다)."""
    _assert_user_id(user_id)

    @unit_of_work(timeout=5.0)
    async def work(tx: AsyncManagedTransaction) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        nres = await tx.run(_NODES_CYPHER, userId=user_id)
        node_rows = [r.data() async for r in nres]
        eres = await tx.run(_EDGES_CYPHER, userId=user_id, person=PERSON_ID)
        edge_rows = [r.data() async for r in eres]
        return node_rows, edge_rows

    async with graph.driver().session(database=graph.database) as session:
        node_rows, edge_rows = await session.execute_read(work)
    return build_career_graph(user_id, node_rows, edge_rows, person_name)
