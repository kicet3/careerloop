"""엔드포인트·큐·스위퍼 — 인증, 멱등, 본문 신원 무시, CLI 엔진 거절, 동시 실행 수."""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.jobs.base import JobKind, JobRef, WorkerContext, queued_sweep_sql, table_precheck
from app.jobs.queue import JobQueue
from app.jobs.sweeper import sweep_once
from app.main import create_app
from app.security.signing import signed_headers
from tests.fakes import SECRET, FakeDb, make_context, make_settings


def _jobs_db(rows: dict[tuple[str, str], dict[str, Any]]) -> FakeDb:
    def handler(sql: str, params: Any) -> list[dict[str, Any]]:
        if "FROM demo_jobs WHERE id" in sql:
            row = rows.get((params["id"], params["run_id"]))
            return [row] if row and row["status"] in params["statuses"] else []
        return []

    return FakeDb(handler)


def _kind(ran: list[tuple[str, str, str]], done: threading.Event | None = None) -> JobKind:
    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        # 실제 작업은 여기서 DB 행을 다시 읽어 user_id를 얻는다 — 테스트는 precheck 결과를 확인한다.
        ref = await ctx.db.fetchone("SELECT ... FROM demo_jobs WHERE id", {"id": job_id, "run_id": run_id, "statuses": ["queued", "running"]})
        ran.append((job_id, run_id, ref["user_id"] if ref else "-"))
        if done:
            done.set()

    return JobKind(name="demo", run=run, precheck=table_precheck("demo_jobs", ("queued", "running")), sweep_query=queued_sweep_sql("demo_jobs"))


ROWS = {
    ("job_1", "run_1"): {"id": "job_1", "run_id": "run_1", "user_id": "owner_1", "provider": "anthropic", "status": "queued"},
    ("job_cli", "run_1"): {"id": "job_cli", "run_id": "run_1", "user_id": "owner_2", "provider": "claude-cli", "status": "queued"},
    ("job_done", "run_1"): {"id": "job_done", "run_id": "run_1", "user_id": "owner_1", "provider": "anthropic", "status": "completed"},
}


def _post(client: TestClient, path: str, body: Any, *, secret: str = SECRET, raw: str | None = None) -> Any:
    data = raw if raw is not None else json.dumps(body, separators=(",", ":"))
    return client.post(path, content=data, headers={"content-type": "application/json", **signed_headers(secret, "POST", path, data)})


@pytest.fixture
def app_client():
    ran: list[tuple[str, str, str]] = []
    done = threading.Event()
    ctx = make_context(_jobs_db(ROWS))
    app = create_app(make_settings(), context=ctx, kinds=[_kind(ran, done)], background=False)
    with TestClient(app) as client:
        yield client, ran, done, ctx


def test_healthz_is_public_and_empty(app_client) -> None:
    client, *_ = app_client
    r = client.get("/healthz")
    assert r.status_code == 204 and r.content == b""
    assert client.get("/docs").status_code == 404 and client.get("/openapi.json").status_code == 404


def test_readyz_requires_hmac(app_client) -> None:
    client, _, _, ctx = app_client
    assert client.get("/readyz").status_code == 401
    r = client.get("/readyz", headers=signed_headers(SECRET, "GET", "/readyz", b""))
    assert r.status_code == 200 and r.json()["db"] == "ok" and r.json()["neo4j"] == "disabled"
    ctx.db.fail_ping = True
    assert client.get("/readyz", headers=signed_headers(SECRET, "GET", "/readyz", b"")).status_code == 503


def test_submit_requires_valid_signature(app_client) -> None:
    client, ran, *_ = app_client
    body = {"id": "job_1", "runId": "run_1"}
    assert client.post("/v1/jobs/demo", json=body).status_code == 401
    assert _post(client, "/v1/jobs/demo", body, secret="w" * 40).status_code == 401
    # 다른 경로의 서명은 통하지 않는다.
    data = json.dumps(body)
    h = signed_headers(SECRET, "POST", "/v1/jobs/other", data)
    assert client.post("/v1/jobs/demo", content=data, headers=h).status_code == 401
    assert ran == []


def test_submit_runs_job_and_reads_owner_from_db(app_client) -> None:
    client, ran, done, _ = app_client
    r = _post(client, "/v1/jobs/demo", {"id": "job_1", "runId": "run_1"})
    assert r.status_code == 202
    assert done.wait(5)
    assert ran == [("job_1", "run_1", "owner_1")]


def test_body_with_user_id_is_rejected(app_client) -> None:
    client, ran, *_ = app_client
    assert _post(client, "/v1/jobs/demo", {"id": "job_1", "runId": "run_1", "userId": "attacker"}).status_code == 422
    assert _post(client, "/v1/jobs/demo", {"id": "../x", "runId": "run_1"}).status_code == 422
    assert _post(client, "/v1/jobs/demo", None, raw="not json").status_code == 422
    assert ran == []


def test_unknown_kind_missing_job_and_cli_provider(app_client) -> None:
    client, ran, *_ = app_client
    assert _post(client, "/v1/jobs/nope", {"id": "job_1", "runId": "run_1"}).status_code == 404
    assert _post(client, "/v1/jobs/demo", {"id": "job_1", "runId": "other_run"}).status_code == 404
    assert _post(client, "/v1/jobs/demo", {"id": "job_done", "runId": "run_1"}).status_code == 404
    assert _post(client, "/v1/jobs/demo", {"id": "job_cli", "runId": "run_1"}).status_code == 409
    assert ran == []


def test_body_size_limit(app_client) -> None:
    client, *_ = app_client
    big = json.dumps({"id": "job_1", "runId": "x" * 70_000})
    assert _post(client, "/v1/jobs/demo", None, raw=big).status_code == 413


def test_disabled_kind_is_404() -> None:
    ctx = make_context(_jobs_db(ROWS))
    app = create_app(make_settings(worker_jobs="resume-draft"), context=ctx, kinds=[_kind([])], background=False)
    with TestClient(app) as client:
        assert _post(client, "/v1/jobs/demo", {"id": "job_1", "runId": "run_1"}).status_code == 404


# --- 큐 ---------------------------------------------------------------------


async def test_queue_is_idempotent_and_bounded_concurrency() -> None:
    running = 0
    peak = 0
    calls: list[str] = []
    release = asyncio.Event()

    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        calls.append(job_id)
        await release.wait()
        running -= 1

    async def precheck(ctx: WorkerContext, job_id: str, run_id: str) -> JobRef:
        return JobRef(job_id, run_id, "u", "anthropic", "queued")

    kind = JobKind("demo", run, precheck)
    q = JobQueue(make_context(), {"demo": kind}, concurrency=2, backlog=1)
    await q.start()
    assert await q.accept("demo", "a", "r") == "queued"
    assert await q.accept("demo", "a", "r") == "duplicate"
    assert await q.accept("demo", "a", "r2") == "queued"  # 새 runId는 다른 실행
    assert await q.accept("demo", "b", "r") == "queued"
    await asyncio.sleep(0.05)
    assert peak == 2
    assert await q.accept("demo", "a", "r") == "duplicate"  # 실행 중에도 멱등
    release.set()
    await q.join()
    assert sorted(calls) == ["a", "a", "b"]
    assert await q.accept("demo", "a", "r") == "queued"  # 끝난 뒤에는 다시 받는다(실행부의 조건부 UPDATE가 막는다)
    await q.join()
    await q.stop()


async def test_queue_full_and_job_errors_do_not_kill_workers() -> None:
    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        if job_id == "bad":
            raise RuntimeError("secret resume text must not be logged")

    async def precheck(ctx: WorkerContext, job_id: str, run_id: str) -> JobRef:
        return JobRef(job_id, run_id, "u", "anthropic", "queued")

    kind = JobKind("demo", run, precheck)
    q = JobQueue(make_context(), {"demo": kind}, concurrency=1, backlog=0)
    assert await q.accept("demo", "bad", "r") == "queued"
    assert await q.accept("demo", "x", "r") == "full"  # 아직 시작 전이라 큐가 찼다
    await q.start()
    await q.join()
    assert await q.accept("demo", "ok", "r") == "queued"
    await q.join()
    await q.stop()


async def test_sweeper_requeues_stale_queued_jobs_via_precheck() -> None:
    def handler(sql: str, params: Any) -> list[dict[str, Any]]:
        if sql.startswith("SELECT id, run_id FROM demo_jobs WHERE status = 'queued'"):
            assert params == {"older_than_sec": 120, "limit": 20}
            return [{"id": "job_1", "run_id": "run_1"}, {"id": "job_cli", "run_id": "run_1"}, {"id": "gone", "run_id": "r"}]
        if "FROM demo_jobs WHERE id" in sql:
            row = ROWS.get((params["id"], params["run_id"]))
            return [row] if row and row["status"] in params["statuses"] else []
        return []

    ran: list[tuple[str, str, str]] = []
    q = JobQueue(make_context(FakeDb(handler)), {"demo": _kind(ran)}, concurrency=1, backlog=00)
    await q.start()
    assert await sweep_once(q, older_than_sec=120) == 1
    await q.join()
    await q.stop()
    assert ran == [("job_1", "run_1", "owner_1")]


def test_sql_identifiers_are_whitelisted() -> None:
    with pytest.raises(ValueError):
        table_precheck("jobs; DROP TABLE users", ("queued",))
    with pytest.raises(ValueError):
        queued_sweep_sql("demo_jobs", status="queued' OR '1'='1")
    assert "provider = 'anthropic'" in queued_sweep_sql("demo_jobs")


async def test_queue_rejects_when_no_free_slot_without_reading_db() -> None:
    """빈 자리가 없으면(실행 중 + 대기 ≥ 동시 실행 수 + backlog) DB를 읽기 전에 'full'(→ 503, Vercel이 바로 실행)."""
    release = asyncio.Event()
    prechecks: list[str] = []

    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        await release.wait()

    async def precheck(ctx: WorkerContext, job_id: str, run_id: str) -> JobRef:
        prechecks.append(job_id)
        return JobRef(job_id, run_id, "u", "anthropic", "running")

    q = JobQueue(make_context(), {"demo": JobKind("demo", run, precheck)}, concurrency=2)
    await q.start()
    assert await q.accept("demo", "a", "r") == "queued"
    assert await q.accept("demo", "b", "r") == "queued"
    await asyncio.sleep(0.02)
    assert q.running == 2
    assert await q.accept("demo", "c", "r") == "full"
    assert prechecks == ["a", "b"]
    assert await q.accept("demo", "a", "r") == "duplicate"  # 멱등은 자리와 상관없다
    release.set()
    await q.join()
    assert await q.accept("demo", "c", "r") == "queued"
    await q.join()
    await q.stop()


async def test_queue_precheck_timeout_raises_and_does_not_enqueue() -> None:
    """precheck가 느리면(풀 대기·DB 지연) Vercel 디스패치 타임아웃(5초) 전에 TimeoutError → 엔드포인트 503. 큐에 넣지 않는다."""
    ran: list[str] = []

    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        ran.append(job_id)

    async def precheck(ctx: WorkerContext, job_id: str, run_id: str) -> JobRef:
        await asyncio.sleep(1)
        return JobRef(job_id, run_id, "u", "anthropic", "running")

    q = JobQueue(make_context(), {"demo": JobKind("demo", run, precheck)}, concurrency=1, precheck_timeout_sec=0.05)
    await q.start()
    with pytest.raises(TimeoutError):
        await q.accept("demo", "slow", "r")
    assert q.size == 0 and ran == []
    await q.stop()


def test_precheck_timeout_is_503(monkeypatch: pytest.MonkeyPatch) -> None:
    async def slow(ctx: WorkerContext, job_id: str, run_id: str) -> JobRef:
        await asyncio.sleep(5)
        return JobRef(job_id, run_id, "u", "anthropic", "running")

    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        raise AssertionError("실행되면 안 된다")

    import app.jobs.queue as queue_mod

    monkeypatch.setattr(queue_mod.JobQueue.__init__, "__kwdefaults__", {**queue_mod.JobQueue.__init__.__kwdefaults__, "precheck_timeout_sec": 0.05})
    app = create_app(make_settings(), context=make_context(), kinds=[JobKind("demo", run, slow)], background=False)
    with TestClient(app) as client:
        assert _post(client, "/v1/jobs/demo", {"id": "job_1", "runId": "run_1"}).status_code == 503


def test_auth_failed_log_does_not_allow_line_injection(app_client, caplog: pytest.LogCaptureFixture) -> None:
    from app.security.signing import log_safe_path

    client, *_ = app_client
    with caplog.at_level("WARNING", logger="worker.auth"):
        r = client.post("/v1/jobs/x%0A2026-11-09%20INFO%20worker%20job_accepted%20kind=resume-draft", json={"id": "a", "runId": "b"})
        assert r.status_code == 401
    lines = [r.getMessage() for r in caplog.records if "auth_failed" in r.getMessage()]
    assert lines and all("\n" not in m and "\r" not in m and " INFO " not in m for m in lines)
    assert log_safe_path("/a\r\nb c\x00é") == "/a??b?c??"
    assert log_safe_path("/" + "x" * 300).endswith("…") and len(log_safe_path("/" + "x" * 300)) == 121
