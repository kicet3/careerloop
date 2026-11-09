"""'portfolio-graph' 작업 실행 — FakeLlmClient로.

- 가짜 DB(항상): 요청 본문을 믿지 않는지, claim에 지면 아무것도 하지 않는지.
- 실제 Postgres(WORKER_TEST_DATABASE_URL이 있을 때만, prisma/migrations를 적용한 임시 DB): 성공 경로·이중 실행 방지(TS claim과 같은 SQL)·
  LLM 실패 문구(TS와 같은 한국어)·사용자 간 격리·다시 만들기·버려진 실행·시간 초과.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest

from app.db import Database
from app.jobs import portfolio_graph, portfolio_graph_material
from app.jobs.base import WorkerContext
from app.jobs.portfolio_graph_material import UNKNOWN_PROJECT_MESSAGE
from app.jobs.portfolio_graph_output import GENERIC_ERROR, TIMEOUT_MESSAGE
from app.jobs.queue import JobQueue
from app.llm.types import LlmPermanentError
from app.storage import Storage
from tests.conftest import load_fixture
from tests.fake_llm import FakeLlmClient
from tests.fakes import FakeDb, make_context, make_settings
from tests.portfolio_graph_support import (
    A,
    A_MARK,
    B,
    B_MARK,
    EnabledGraph,
    GraphStore,
    RecordingFactory,
    create_test_database,
    insert_job,
    portfolio_handler,
    real_database_url,
    seed_users,
)

TS_ERRORS = {c["name"]: c["message"] for c in load_fixture("prompts/portfolio-graph-postprocess.json")["errors"]}
#: TS claimGraphPortfolioRun(runner 'vercel')과 같은 SQL — Vercel 경로가 먼저 맡은 상황.
TS_CLAIM = (
    "UPDATE portfolio_draft_jobs SET result = jsonb_build_object('claimRunId', run_id, 'runner', 'vercel'::text) "
    "WHERE id = %(id)s AND user_id = %(u)s AND run_id = %(r)s AND status = 'running' AND (result IS NULL OR result->>'claimRunId' IS DISTINCT FROM run_id)"
)


# ---------------------------------------------------------------------------
# 가짜 DB
# ---------------------------------------------------------------------------


async def test_unknown_job_row_does_nothing() -> None:
    db = FakeDb(lambda sql, params: [])
    llm = FakeLlmClient({"portfolio-draft": portfolio_handler})
    ctx = make_context(db)
    ctx.llm = RecordingFactory(llm)  # type: ignore[assignment]
    await portfolio_graph.run(ctx, "job_x", "run_x")
    assert len(db.calls) == 1 and db.calls[0][0].startswith("SELECT")
    assert llm.calls == []


async def test_lost_claim_writes_nothing_and_uses_row_user_id() -> None:
    """claim(조건부 UPDATE)이 0행이면(Vercel이 먼저 맡음) 그 뒤로 아무것도 읽거나 쓰지 않는다. claim의 user_id는 작업 행의 값이다."""

    def handler(sql: str, params: Any) -> Any:
        if sql.startswith("SELECT id, user_id"):
            return [{"id": "job_x", "user_id": "row_user", "run_id": "run_x", "status": "running", "label": "l", "input": {"projectIds": ["p1"]}, "provider": "anthropic", "started_at": None}]
        if sql.startswith("UPDATE portfolio_draft_jobs SET result"):
            return 0
        raise AssertionError(f"claim에 진 뒤 실행한 SQL: {sql[:60]}")

    db = FakeDb(handler)
    llm = FakeLlmClient({"portfolio-draft": portfolio_handler})
    ctx = make_context(db)
    ctx.llm = RecordingFactory(llm)  # type: ignore[assignment]
    await portfolio_graph.run(ctx, "job_x", "run_x")
    assert [c[0].split()[0] for c in db.calls] == ["SELECT", "UPDATE"]
    assert db.calls[1][1]["user_id"] == "row_user" and db.calls[1][1]["runner"] == "worker"
    assert llm.calls == []


async def test_precheck_rejects_cli_provider() -> None:
    """엔진이 'anthropic'이 아니면 큐에 넣지 않는다(→ 409, Vercel이 실행)."""
    db = FakeDb(lambda sql, params: [{"id": "j", "run_id": "r", "user_id": "u", "provider": "claude-cli", "status": "running"}])
    q = JobQueue(make_context(db), {"portfolio-graph": portfolio_graph.KIND}, concurrency=1, backlog=8)
    assert await q.accept("portfolio-graph", "j", "r") == "unsupported_provider"
    db2 = FakeDb(lambda sql, params: [])
    q2 = JobQueue(make_context(db2), {"portfolio-graph": portfolio_graph.KIND}, concurrency=1, backlog=8)
    assert await q2.accept("portfolio-graph", "j", "r") == "not_found"


# ---------------------------------------------------------------------------
# 실제 Postgres
# ---------------------------------------------------------------------------

pg = pytest.mark.skipif(real_database_url() is None, reason="WORKER_TEST_DATABASE_URL이 없어 실제 Postgres 테스트를 건너뛴다")


@pytest.fixture(scope="module")
def pg_url() -> Iterator[str]:
    admin = real_database_url()
    assert admin
    url, drop = create_test_database(admin)
    try:
        yield url
    finally:
        drop()


class Env:
    def __init__(self, ctx: WorkerContext, db: Database, llm: FakeLlmClient, factory: RecordingFactory, graphs: GraphStore, storage_dir: Path) -> None:
        self.ctx, self.db, self.llm, self.factory, self.graphs, self.storage_dir = ctx, db, llm, factory, graphs, storage_dir

    async def job(self, job_id: str = "job_a") -> dict[str, Any]:
        row = await self.db.fetchone("SELECT * FROM portfolio_draft_jobs WHERE id = %(id)s", {"id": job_id})
        assert row
        return row

    async def count(self, sql: str, params: Any = None) -> int:
        row = await self.db.fetchone(f"SELECT count(*)::int AS n FROM {sql}", params)
        return row["n"] if row else 0

    def text(self, key: str) -> str:
        return (self.storage_dir / key).read_text("utf-8")


@pytest.fixture
async def env(pg_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[Env]:
    db = Database(pg_url, min_size=1, max_size=4)
    await db.open()
    for t in ("notifications", "portfolio_draft_jobs", "portfolios", "github_repo_snapshots", "github_accounts", "job_postings", "llm_usage_events", "users"):
        await db.execute(f"DELETE FROM {t}")
    await seed_users(db)
    llm = FakeLlmClient({"portfolio-draft": portfolio_handler})
    factory = RecordingFactory(llm)
    graphs = GraphStore()
    monkeypatch.setattr(portfolio_graph_material, "get_career_graph", graphs.get_career_graph)
    storage_dir = tmp_path / "storage"
    ctx = WorkerContext(
        settings=make_settings(),
        db=db,
        llm=factory,  # type: ignore[arg-type]
        graph=EnabledGraph(),  # type: ignore[arg-type]
        storage=Storage(production=False, env={"STORAGE_DIR": str(storage_dir)}),
    )
    try:
        yield Env(ctx, db, llm, factory, graphs, storage_dir)
    finally:
        await db.close()


@pg
async def test_success_creates_graph_portfolio_and_notifies(env: Env) -> None:
    await insert_job(env.db, input_={"projectIds": ["p1"], "postingId": "post_a", "notes": "성능 개선 강조", "templateId": "project-pdf", "provider": "anthropic"})
    await portfolio_graph.run(env.ctx, "job_a", "run_a")

    job = await env.job()
    assert (job["status"], job["stage"], job["error"], job["input"]) == ("completed", "saving", None, None)
    assert job["result"] == {"notes": ["성능을 강조했다"], "missingInfo": job["result"]["missingInfo"], "regenerate": False}
    assert job["completed_at"] is not None and job["portfolio_id"]
    pf = await env.db.fetchone("SELECT * FROM portfolios WHERE id = %(id)s", {"id": job["portfolio_id"]})
    assert pf and pf["user_id"] == A["id"] and pf["kind"] == "graph" and pf["title"] == "백엔드 포트폴리오"
    assert pf["text_key"].startswith(f"users/{A['id']}/portfolios/{pf['id']}/text-")
    md = env.text(pf["text_key"])
    assert pf["chars"] == len(md.strip())
    assert md.startswith("# 백엔드 포트폴리오\n\n**에이**")
    # 링크: 그래프 Project.url과 A의 공개 저장소만(비공개·B의 저장소는 없다).
    assert f"https://{A_MARK.lower()}.dev/pay" in md and "https://github.com/ua/pay" in md
    assert "secret-pay" not in md and B_MARK not in md
    # 지어낸 수치는 확인 표시.
    assert "[ADD: 수치 확인 — 전환율 35% 향상]" in md and "정산 시간 6시간→40분" in md
    gs = pf["graph_source"]
    assert gs["projectIds"] == ["p1"] and gs["postingId"] == "post_a" and gs["notes"] == "성능 개선 강조" and gs["templateId"] == "project-pdf"
    assert gs["addMarkers"] == md.count("[ADD:") and any("35" in m for m in gs["missingInfo"])
    # LLM: 한 번, 작업 행의 사용자로 기록, 프롬프트에는 A의 자료와 A의 공고만.
    assert len(env.llm.calls) == 1
    req = env.llm.calls[0]
    assert req.task == "portfolio-draft" and req.max_tokens == 128_000 and req.effort == "medium"
    assert A_MARK in req.user and B_MARK not in req.user and "Kotlin 정산 경험" in req.user
    assert [(p, c.user_id, c.reference_id) for p, c in env.factory.created] == [("anthropic", A["id"], "job_a")]
    n = await env.db.fetchall("SELECT kind, title, body, link FROM notifications WHERE user_id = %(u)s", {"u": A["id"]})
    assert n == [{"kind": "portfolio-draft-completed", "title": "경험 그래프 포트폴리오가 완성됐습니다", "body": n[0]["body"], "link": f"/app/portfolios/{pf['id']}"}]
    assert n[0]["body"].startswith("백엔드 포트폴리오 — 채워야 할 정보 ")


@pg
async def test_guard_vercel_claimed_first(env: Env) -> None:
    """Vercel(after) 경로가 같은 runId를 먼저 맡았으면 워커는 아무것도 하지 않는다."""
    await insert_job(env.db)
    assert await env.db.execute(TS_CLAIM, {"id": "job_a", "u": A["id"], "r": "run_a"}) == 1
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    job = await env.job()
    assert job["status"] == "running" and job["stage"] == "material" and job["result"] == {"claimRunId": "run_a", "runner": "vercel"}
    assert env.llm.calls == [] and await env.count("portfolios") == 0 and await env.count("notifications") == 0
    # 반대로 워커가 먼저 맡았으면 TS claim이 0행이다.
    await insert_job(env.db, job_id="job_b", run_id="run_b")
    await portfolio_graph.run(env.ctx, "job_b", "run_b")
    assert await env.db.execute(TS_CLAIM, {"id": "job_b", "u": A["id"], "r": "run_b"}) == 0


@pg
async def test_guard_concurrent_runs_execute_once(env: Env) -> None:
    """같은 (id, runId)를 동시에 두 번 실행해도 LLM 호출·포트폴리오·알림은 하나."""
    await insert_job(env.db)
    env.llm.delay_sec = 0.2
    await asyncio.gather(portfolio_graph.run(env.ctx, "job_a", "run_a"), portfolio_graph.run(env.ctx, "job_a", "run_a"))
    assert len(env.llm.calls) == 1
    assert (await env.job())["status"] == "completed"
    assert await env.count("portfolios") == 1 and await env.count("notifications") == 1


@pg
async def test_retry_with_new_run_id_can_claim_again(env: Env) -> None:
    """실패 뒤 다시 시도(새 runId)는 남은 claim 표시와 상관없이 다시 맡는다."""
    await insert_job(env.db)
    env.llm.errors["portfolio-draft"] = LlmPermanentError("거절", "refusal")
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    assert (await env.job())["status"] == "failed"
    await env.db.execute("UPDATE portfolio_draft_jobs SET run_id = 'run_2', status = 'running', error = NULL WHERE id = 'job_a'")
    await portfolio_graph.run(env.ctx, "job_a", "run_2")
    assert (await env.job())["status"] == "completed"


@pg
async def test_llm_failure_writes_ts_message_and_notifies(env: Env) -> None:
    await insert_job(env.db)
    env.llm.errors["portfolio-draft"] = LlmPermanentError("거절", "refusal")
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    job = await env.job()
    assert job["status"] == "failed"
    assert job["error"] == TS_ERRORS["LlmPermanentError refusal"] == "포트폴리오를 만들지 못했습니다. AI 모델이 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요."
    assert job["input"] is not None  # 다시 시도에 쓴다
    assert await env.count("portfolios") == 0
    n = await env.db.fetchall("SELECT kind, title, body, link FROM notifications")
    assert n == [{"kind": "portfolio-draft-failed", "title": "경험 그래프 포트폴리오를 만들지 못했습니다", "body": f"백엔드 포트폴리오 — {job['error']}", "link": "/app/portfolios/drafts/job_a"}]


@pg
async def test_unexpected_error_writes_generic_message(env: Env) -> None:
    await insert_job(env.db)
    env.llm.errors["portfolio-draft"] = RuntimeError("SDK 내부 오류: 본문이 섞일 수 있음")
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    assert (await env.job())["error"] == GENERIC_ERROR == TS_ERRORS["기타 오류"]


@pg
async def test_timeout_message(env: Env) -> None:
    await insert_job(env.db)
    env.llm.delay_sec = 2.0
    await portfolio_graph.run(env.ctx, "job_a", "run_a", time_limit_ms=1_000)
    job = await env.job()
    assert (job["status"], job["error"]) == ("failed", TIMEOUT_MESSAGE)
    assert TIMEOUT_MESSAGE == TS_ERRORS["TimeoutError"]


@pg
async def test_isolation_user_comes_from_job_row(env: Env) -> None:
    """B의 작업을 실행하면 B의 그래프·공고·저장소만 쓰고 결과도 B에게 간다(본문에 user_id가 없다)."""
    await insert_job(env.db, job_id="b_job", user_id=B["id"], run_id="b_run", input_={"projectIds": ["p1", "pb_only"], "postingId": "post_b", "templateId": "project-pdf"}, label="B 포트폴리오")
    await portfolio_graph.run(env.ctx, "b_job", "b_run")
    job = await env.job("b_job")
    assert job["status"] == "completed"
    assert env.graphs.calls == [B["id"]]
    req = env.llm.calls[0]
    assert B_MARK in req.user and A_MARK not in req.user and "페이랩" not in req.user
    assert [c.user_id for _, c in env.factory.created] == [B["id"]]
    pf = await env.db.fetchone("SELECT user_id, text_key FROM portfolios WHERE id = %(id)s", {"id": job["portfolio_id"]})
    assert pf and pf["user_id"] == B["id"] and pf["text_key"].startswith(f"users/{B['id']}/")
    assert "https://github.com/ua/pay" not in env.text(pf["text_key"])
    assert await env.count("notifications WHERE user_id = 'ua'") == 0


@pg
async def test_isolation_other_users_project_id_and_posting(env: Env) -> None:
    """A의 작업 입력에 B에게만 있는 프로젝트 id가 있으면 LLM 없이 400 문구로 실패. 남의 공고 id는 공고 없이 만든다."""
    await insert_job(env.db, input_={"projectIds": ["p1", "pb_only"]})
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    assert (await env.job())["error"] == UNKNOWN_PROJECT_MESSAGE and env.llm.calls == []

    await insert_job(env.db, job_id="job_c", run_id="run_c", input_={"projectIds": ["p1"], "postingId": "post_b"})
    await portfolio_graph.run(env.ctx, "job_c", "run_c")
    job = await env.job("job_c")
    assert job["status"] == "completed" and B_MARK not in env.llm.calls[-1].user
    pf = await env.db.fetchone("SELECT graph_source FROM portfolios WHERE id = %(id)s", {"id": job["portfolio_id"]})
    assert pf and pf["graph_source"]["postingId"] is None


@pg
async def test_isolation_graph_loader_leak_fails_without_llm(env: Env) -> None:
    """그래프 로더가 다른 사용자의 그래프를 돌려주면(버그) 소유자 확인에서 막혀 LLM을 부르지 않는다."""
    env.graphs.leak_from = B["id"]
    await insert_job(env.db)
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    job = await env.job()
    assert job["status"] == "failed" and job["error"] == GENERIC_ERROR
    assert env.llm.calls == []


@pg
async def test_regenerate_replaces_text_and_source(env: Env) -> None:
    await insert_job(env.db)
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    pid = (await env.job())["portfolio_id"]
    old = await env.db.fetchone("SELECT text_key FROM portfolios WHERE id = %(id)s", {"id": pid})
    assert old
    await insert_job(env.db, job_id="job_r", run_id="run_r", input_={"projectIds": ["p1", "p2"], "templateId": "case-study", "portfolioId": pid}, portfolio_id=pid, label="백엔드 포트폴리오")
    await portfolio_graph.run(env.ctx, "job_r", "run_r")
    job = await env.job("job_r")
    assert job["status"] == "completed" and job["portfolio_id"] == pid and job["result"]["regenerate"] is True
    pf = await env.db.fetchone("SELECT text_key, graph_source FROM portfolios WHERE id = %(id)s", {"id": pid})
    assert pf and pf["text_key"] != old["text_key"] and pf["graph_source"]["templateId"] == "case-study"
    assert "## Case 2." in env.text(pf["text_key"])
    assert not (env.storage_dir / old["text_key"]).exists()
    assert await env.count("portfolios") == 1
    n = await env.db.fetchone("SELECT title FROM notifications ORDER BY created_at DESC, id DESC LIMIT 1")
    assert n and n["title"] == "포트폴리오를 다시 만들었습니다"


@pg
async def test_regenerate_aborted_when_job_closed_before_commit(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """본문을 바꾸는 사이 작업이 멈춤 판정으로 닫히면(완료 기록 0행) 본문·생성 정보를 되돌리고 새 본문을 지운다."""
    await insert_job(env.db)
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    pid = (await env.job())["portfolio_id"]
    before = await env.db.fetchone("SELECT text_key, graph_source FROM portfolios WHERE id = %(id)s", {"id": pid})
    await insert_job(env.db, job_id="job_r", run_id="run_r", input_={"projectIds": ["p1"], "portfolioId": pid}, portfolio_id=pid)
    put = env.ctx.storage.put_object

    async def put_then_close(key: str, body: Any, content_type: str | None = None) -> None:
        await put(key, body, content_type)
        await env.db.execute("UPDATE portfolio_draft_jobs SET status = 'failed', error = 'stale' WHERE id = 'job_r'")

    monkeypatch.setattr(env.ctx.storage, "put_object", put_then_close)
    await portfolio_graph.run(env.ctx, "job_r", "run_r")
    after = await env.db.fetchone("SELECT text_key, graph_source FROM portfolios WHERE id = %(id)s", {"id": pid})
    assert after == before
    assert sorted(p.name for p in (env.storage_dir / f"users/{A['id']}/portfolios/{pid}").iterdir()) == [Path(before["text_key"]).name]  # type: ignore[index]
    job = await env.job("job_r")
    assert (job["status"], job["error"]) == ("failed", "stale")


@pg
async def test_new_portfolio_discarded_when_job_closed_after_create(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """만든 뒤 완료 기록이 0행이면(그사이 멈춤 판정) 만든 포트폴리오와 본문을 지우고 알림을 남기지 않는다."""
    await insert_job(env.db)
    put = env.ctx.storage.put_object

    async def put_then_close(key: str, body: Any, content_type: str | None = None) -> None:
        await put(key, body, content_type)
        await env.db.execute("UPDATE portfolio_draft_jobs SET status = 'failed', error = 'stale' WHERE id = 'job_a'")

    monkeypatch.setattr(env.ctx.storage, "put_object", put_then_close)
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    assert await env.count("portfolios") == 0 and await env.count("notifications") == 0
    assert not (env.storage_dir / f"users/{A['id']}/portfolios").exists() or not any((env.storage_dir / f"users/{A['id']}/portfolios").rglob("*.txt"))


@pg
async def test_bad_input_fails_with_ts_message(env: Env) -> None:
    await insert_job(env.db, input_={"projectIds": []})
    await portfolio_graph.run(env.ctx, "job_a", "run_a")
    assert (await env.job())["error"] == "작업 입력을 읽지 못했습니다. 포트폴리오 화면에서 다시 만들어 주세요."


@pg
async def test_queue_accepts_running_anthropic_job(env: Env) -> None:
    await insert_job(env.db)
    q = JobQueue(env.ctx, {"portfolio-graph": portfolio_graph.KIND}, concurrency=1, backlog=8)
    assert await q.accept("portfolio-graph", "job_a", "wrong_run") == "not_found"
    assert await q.accept("portfolio-graph", "job_a", "run_a") == "queued"
    await q.start()
    await q.join()
    await q.stop()
    assert (await env.job())["status"] == "completed"
    assert json.dumps(env.factory.created[0][1].user_id) == '"ua"'
