"""작업 종류(kind) 계약. 새 종류는 app/jobs/<kind>.py에 KIND = JobKind(...)를 두고 app/jobs/registry.py에 한 줄을 더한다.

보안 규칙(작업 모듈이 지킨다):
- 요청 본문에는 작업 id와 runId만 온다. user_id·provider·입력은 모두 DB 작업 행에서 다시 읽는다.
- 실행은 TS 실행부와 같은 조건부 UPDATE(WHERE id=%s AND run_id=%s AND status IN (...))로 시작·기록한다 — Vercel after() 경로와 겹쳐도
  한쪽만 이긴다. 영향받은 행이 0이면 아무것도 쓰지 않고 끝낸다.
- 다른 사용자 자료는 user_id 조건(SQL)·assert_graph_owner(그래프)·assert_user_key(저장소)로 코드에서 막는다.
- 로그에는 작업 id·kind·걸린 시간·토큰 수만 남긴다(이력서·JD·프롬프트 본문 금지).
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.config import Settings
    from app.db import Database
    from app.graph.client import GraphClient
    from app.llm.factory import LlmFactory
    from app.storage import Storage


@dataclass
class WorkerContext:
    """작업 실행에 필요한 공용 자원(프로세스당 하나). 테스트는 가짜를 넣어 만든다."""

    settings: Settings
    db: Database
    llm: LlmFactory
    graph: GraphClient
    storage: Storage


@dataclass(frozen=True)
class JobRef:
    """디스패치 전 확인(precheck)이 DB 작업 행에서 읽은 값."""

    id: str
    run_id: str
    user_id: str
    provider: str | None
    status: str


#: (ctx, job_id, run_id) → None. 던지지 않는 것이 원칙이다(실패는 작업 행에 기록). 던지면 큐가 오류 이름만 로그에 남긴다.
RunFn = Callable[[WorkerContext, str, str], Awaitable[None]]
#: (ctx, job_id, run_id) → JobRef | None. 이 (id, runId)로 실행할 수 있는 행이 없으면 None(→ 404, Vercel이 직접 실행 — 거기서도 할 일이 없으면 끝난다).
PrecheckFn = Callable[[WorkerContext, str, str], Awaitable[JobRef | None]]


@dataclass(frozen=True)
class JobKind:
    #: URL의 {kind}(예: 'resume-draft'). Vercel WORKER_JOBS 값과 같다.
    name: str
    run: RunFn
    precheck: PrecheckFn
    #: 스위퍼가 다시 집을 작업 SQL(없으면 None). %(older_than_sec)s·%(limit)s 매개변수를 받고 id·run_id 열을 돌려준다. queued_sweep_sql로 만든다.
    sweep_query: str | None = None


_IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _ident(name: str) -> str:
    """SQL 식별자(표·열 이름)는 코드 상수만 — 이 형식이 아니면 거절한다."""
    if not _IDENT_RE.match(name):
        raise ValueError(f"잘못된 SQL 식별자: {name!r}")
    return name


def table_precheck(table: str, runnable_statuses: tuple[str, ...], *, user_column: str = "user_id", provider_column: str = "provider") -> PrecheckFn:
    """작업 표 하나에서 (id, run_id, status ∈ runnable_statuses) 행을 읽는 precheck."""
    t, uc, pc = _ident(table), _ident(user_column), _ident(provider_column)
    sql = f"SELECT id, run_id, {uc} AS user_id, {pc} AS provider, status FROM {t} WHERE id = %(id)s AND run_id = %(run_id)s AND status = ANY(%(statuses)s)"

    async def precheck(ctx: WorkerContext, job_id: str, run_id: str) -> JobRef | None:
        row: dict[str, Any] | None = await ctx.db.fetchone(sql, {"id": job_id, "run_id": run_id, "statuses": list(runnable_statuses)})
        if row is None or not row.get("user_id"):
            return None
        return JobRef(id=row["id"], run_id=row["run_id"], user_id=row["user_id"], provider=row.get("provider"), status=row["status"])

    return precheck


def queued_sweep_sql(table: str, *, status: str = "queued", since_column: str = "updated_at", provider_column: str = "provider") -> str:
    """'queued'인 채 older_than_sec 넘게 아무도 집지 않은 anthropic 작업(오래된 것부터 limit개)."""
    t, sc, pc = _ident(table), _ident(since_column), _ident(provider_column)
    if not re.match(r"^[a-z_-]{1,32}$", status):
        raise ValueError("잘못된 상태 값")
    return (
        f"SELECT id, run_id FROM {t} WHERE status = '{status}' AND {pc} = 'anthropic' AND run_id IS NOT NULL "
        f"AND {sc} < now() - make_interval(secs => %(older_than_sec)s::double precision) ORDER BY {sc} LIMIT %(limit)s"
    )
