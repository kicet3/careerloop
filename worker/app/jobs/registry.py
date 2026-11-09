"""작업 종류 등록부. 새 종류: app/jobs/<kind>.py에 `KIND = JobKind(name=..., run=..., precheck=..., sweep_query=...)`를 두고
아래 목록에 `<module>.KIND,` 한 줄을 더한다(docs/PYTHON-WORKER.md §5 — 포팅 순서대로).
"""

from __future__ import annotations

from app.jobs.base import JobKind

# 예: from app.jobs import resume_draft


def registered_kinds() -> list[JobKind]:
    return [
        _resume_draft_kind(),
        *_interview_kinds(),
        _portfolio_graph_kind(),
    ]


def _resume_draft_kind() -> JobKind:
    from app.jobs import resume_draft

    return resume_draft.KIND


def _portfolio_graph_kind() -> JobKind:
    from app.jobs import portfolio_graph

    return portfolio_graph.KIND


def _interview_kinds() -> list[JobKind]:
    from app.jobs import interview_feedback, interview_questions

    return [interview_questions.KIND, interview_feedback.KIND]


def build_registry(kinds: list[JobKind] | None = None) -> dict[str, JobKind]:
    """이름 → 종류. 이름이 겹치면 시작하지 않는다."""
    out: dict[str, JobKind] = {}
    for k in registered_kinds() if kinds is None else kinds:
        if k.name in out:
            raise ValueError(f"작업 종류 이름이 겹칩니다: {k.name}")
        out[k.name] = k
    return out
