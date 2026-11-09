"""'portfolio-graph' 작업 테스트 공용: 실제 Postgres 준비(WORKER_TEST_DATABASE_URL이 있을 때만), 가짜 LLM 팩토리·그래프, 행 만들기."""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.graph import build_career_graph
from app.llm.types import LlmClient, LlmRequest, assert_worker_provider
from app.llm.usage import LlmUsageContext

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO_ROOT / "prisma" / "migrations"

A = {"id": "ua", "email": "ua@x.com", "name": "에이"}
B = {"id": "ub", "email": "ub@x.com", "name": "비"}
A_MARK = "ALPHAMARK"
B_MARK = "ZQXBMARK"


def real_database_url() -> str | None:
    """WORKER_TEST_DATABASE_URL: CREATE DATABASE 권한이 있는 로컬 주소. 없으면 실제 DB 테스트를 건너뛴다."""
    return (os.environ.get("WORKER_TEST_DATABASE_URL") or "").strip() or None


def create_test_database(admin_url: str) -> tuple[str, Callable[[], None]]:
    """새 DB를 만들고 prisma/migrations를 순서대로 적용한다(스키마의 주인은 Prisma 마이그레이션). (그 DB 주소, 지우는 함수)."""
    import psycopg

    name = f"wt_portfolio_{secrets.token_hex(4)}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')  # type: ignore[arg-type]
    p = urlsplit(admin_url)
    url = urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, ""))
    with psycopg.connect(url, autocommit=True) as conn:
        for d in sorted(x for x in MIGRATIONS.iterdir() if x.is_dir()):
            conn.execute((d / "migration.sql").read_text("utf-8"))  # type: ignore[arg-type]

    def drop() -> None:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')  # type: ignore[arg-type]

    return url, drop


# ---------------------------------------------------------------------------
# 가짜 LLM·그래프
# ---------------------------------------------------------------------------


def portfolio_handler(req: LlmRequest) -> dict[str, Any]:
    """자료에 나온 프로젝트 id마다 한 프로젝트를 쓴다. 지어낸 수치(35%)를 하나 넣어 정리 규칙이 도는지 본다."""
    import re

    ids = re.findall(r"^프로젝트 \[([^\]]+)\] (.*)$", req.user, re.M)
    return {
        "headline": "정산을 빠르게 만드는 개발자",
        "coreSkills": ["Kotlin"],
        "sections": [{"key": "intro", "body": "결제 정산을 다룹니다.", "bullets": []}],
        "projects": [
            {
                "projectId": f"[{pid}]",
                "name": name,
                "oneLiner": "정산 배치를 다시 만들었다",
                "period": "",
                "affiliation": "",
                "techStack": ["Kotlin"],
                "sections": [
                    {"key": "problem", "body": "정산이 느렸다.", "bullets": []},
                    {"key": "result", "body": "", "bullets": ["정산 시간 6시간→40분", "전환율 35% 향상"]},
                ],
            }
            for pid, name in ids
        ],
        "notes": ["성능을 강조했다"],
        "missingInfo": ["팀 규모는?"],
    }


class RecordingFactory:
    """ctx.llm 대신. create()에 넘어온 provider·사용량 문맥(user_id)을 기록한다."""

    model = "fake"

    def __init__(self, client: LlmClient) -> None:
        self.client = client
        self.created: list[tuple[object, LlmUsageContext]] = []

    def create(self, provider: object, ctx: LlmUsageContext) -> LlmClient:
        assert_worker_provider(provider)
        self.created.append((provider, ctx))
        return self.client

    def model_name(self) -> str:
        return self.model

    async def close(self) -> None: ...


class EnabledGraph:
    """그래프 저장소가 켜진 것처럼(실제 조회는 get_career_graph를 바꿔 끼운다)."""

    enabled = True
    database = None

    async def ping(self) -> None: ...
    async def close(self) -> None: ...


def graph_rows(mark: str, user_id: str, extra: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Neo4j 쿼리 결과 모양(props에 userId)."""

    def n(id_: str, label: str, props: dict[str, Any]) -> dict[str, Any]:
        return {"id": id_, "label": label, "props": {**props, "userId": user_id}}

    nodes = [
        n("c1", "Company", {"name": f"{mark}회사"}),
        n("p1", "Project", {"name": f"{mark}결제개선", "summary": f"{mark} 정산 배치를 다시 만들었다", "myRole": "백엔드 리드", "result": "정산 시간 6시간→40분", "url": f"https://{mark.lower()}.dev/pay"}),
        n("p2", "Project", {"name": f"{mark}사내도구"}),
        n("s1", "Skill", {"name": f"{mark}Kotlin"}),
        n("a1", "Achievement", {"summary": f"{mark} 정산 시간 단축", "value": "6시간→40분"}),
        *(extra or []),
    ]
    edges = [
        {"type": "WORKED_ON", "from": "me", "to": "p1"},
        {"type": "PART_OF", "from": "p1", "to": "c1"},
        {"type": "USED_SKILL", "from": "p1", "to": "s1"},
        {"type": "ACHIEVED", "from": "p1", "to": "a1"},
    ]
    return nodes, edges


class GraphStore:
    """get_career_graph 대신: 사용자별 그래프. leak_from을 주면(버그 흉내) 요청 사용자와 상관없이 그 사용자의 그래프를 돌려준다."""

    def __init__(self) -> None:
        self.graphs: dict[str, tuple[list[dict[str, Any]], list[dict[str, Any]]]] = {
            A["id"]: graph_rows(A_MARK, A["id"]),
            B["id"]: graph_rows(B_MARK, B["id"], [{"id": "pb_only", "label": "Project", "props": {"name": f"{B_MARK}비밀", "userId": B["id"]}}]),
        }
        self.leak_from: str | None = None
        self.calls: list[str] = []

    async def get_career_graph(self, _client: Any, user_id: str, person_name: str | None = None) -> Any:
        self.calls.append(user_id)
        owner = self.leak_from or user_id
        nodes, edges = self.graphs.get(owner, ([], []))
        # 소유자 표시는 실제로 읽은 사용자(owner)로 단다 — TS 테스트의 markGraphOwner(…, owner)와 같다.
        return build_career_graph(owner, json.loads(json.dumps(nodes)), edges, person_name)


# ---------------------------------------------------------------------------
# 행 만들기
# ---------------------------------------------------------------------------


async def seed_users(db: Any) -> None:
    for u in (A, B):
        await db.execute("INSERT INTO users (id, email, name, status) VALUES (%(id)s, %(email)s, %(name)s, 'approved')", u)
        await db.execute(
            "INSERT INTO github_accounts (id, user_id, github_user_id, login) VALUES (%(gid)s, %(id)s, %(gid)s, %(id)s)",
            {"gid": f"gh_{u['id']}", "id": u["id"]},
        )
    now = datetime.now(UTC)
    for sid, uid, repo, full, priv, node in [("sa", A["id"], "1", "ua/pay", False, "p1"), ("sa_priv", A["id"], "2", "ua/secret-pay", True, "p2"), ("sb", B["id"], "3", f"ub/{B_MARK}", False, "p1")]:
        await db.execute(
            "INSERT INTO github_repo_snapshots (id, user_id, repo_id, full_name, html_url, private, data, brief, builder_version, fetched_at, project_node_id) "
            "VALUES (%(id)s, %(u)s, %(r)s, %(f)s, %(url)s, %(p)s, '{}'::jsonb, '', 1, %(now)s, %(node)s)",
            {"id": sid, "u": uid, "r": repo, "f": full, "url": f"https://github.com/{full}", "p": priv, "now": now, "node": node},
        )
    await db.execute("INSERT INTO job_postings (id, user_id, company, role_title, jd_text) VALUES ('post_a', 'ua', '페이랩', '백엔드', 'Kotlin 정산 경험')")
    await db.execute(f"INSERT INTO job_postings (id, user_id, company, role_title, jd_text) VALUES ('post_b', 'ub', '{B_MARK}회사', '백엔드', '{B_MARK} JD')")


async def insert_job(
    db: Any,
    *,
    job_id: str = "job_a",
    user_id: str = "ua",
    run_id: str = "run_a",
    input_: dict[str, Any] | None = None,
    provider: str = "anthropic",
    label: str = "백엔드 포트폴리오",
    portfolio_id: str | None = None,
    started_ago_sec: float = 0,
) -> None:
    from psycopg.types.json import Jsonb

    started = datetime.now(UTC) - timedelta(seconds=started_ago_sec)
    inp = input_ if input_ is not None else {"projectIds": ["p1"], "templateId": "project-pdf", "provider": provider}
    await db.execute(
        "INSERT INTO portfolio_draft_jobs (id, user_id, run_id, status, stage, label, input, provider, portfolio_id, started_at, created_at, updated_at) "
        "VALUES (%(id)s, %(u)s, %(r)s, 'running', 'material', %(label)s, %(input)s, %(p)s, %(pid)s, %(s)s, %(s)s, %(s)s)",
        {"id": job_id, "u": user_id, "r": run_id, "label": label, "input": Jsonb(inp), "p": provider, "pid": portfolio_id, "s": started},
    )
