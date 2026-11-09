"""resume-draft 대표 프로젝트 2~3개(TS resumes/project-count.ts): 그래프 자료의 프로젝트 수를 세고, 후처리가 TS와 같은 규칙을 쓴다."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.graph.service import build_career_graph
from app.jobs.resume_draft import load_draft_material
from app.jobs.resume_draft_output import check_project_count
from app.prompts.resume_draft import PROJECT_COUNT_RULE, PROJECT_MORE_QUESTION, SYSTEM


async def test_graph_material_counts_project_nodes() -> None:
    rows = [
        {"id": "p1", "label": "Project", "props": {"userId": "u1", "name": "주문"}},
        {"id": "p2", "label": "Project", "props": {"userId": "u1", "name": "캐시"}},
        {"id": "c1", "label": "Company", "props": {"userId": "u1", "name": "페이랩"}},
    ]

    async def load_graph(graph: Any, user_id: str, name: str | None) -> Any:
        return build_career_graph(user_id, rows, [])

    ctx = SimpleNamespace(graph=SimpleNamespace(enabled=True))
    material = await load_draft_material(ctx, {"id": "u1", "name": None}, {"kind": "graph"}, load_graph=load_graph)  # type: ignore[arg-type]
    assert material is not None and material.kind == "graph"
    assert material.project_count == 2
    assert "프로젝트 수" not in material.text  # 수는 프롬프트에 넣지 않는다


def test_rule_and_check() -> None:
    assert f"\n11. {PROJECT_COUNT_RULE}\n" in SYSTEM
    assert check_project_count([{"name": "A"}], 1).missing_info == [PROJECT_MORE_QUESTION]
    r = check_project_count([{"name": n} for n in ("A", "B", "C", "D")], 4)
    assert r.keep == 3 and "D" in r.notes[0]
