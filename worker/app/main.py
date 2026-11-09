"""CareerLoop AI 워커(FastAPI). 실행: uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8090

| 경로 | 설명 |
|---|---|
| GET /healthz | 프로세스가 살아 있는지(인증 없음, 내용 없음 — 204) |
| GET /readyz | DB·Neo4j 연결 확인(HMAC) |
| POST /v1/jobs/{kind} | 본문 {id, runId}(HMAC). 받으면 202. 같은 (kind, id, runId)가 이미 큐·실행 중이어도 202(멱등) |

그 밖의 응답: 401 서명 없음·틀림, 404 모르는·꺼진 kind 또는 실행할 작업 행이 없음, 409 워커가 실행할 수 없는 엔진(CLI),
413 본문 64KB 초과, 422 본문 형식, 503 DB 오류·큐 가득 참. 202가 아니면 Vercel이 직접 실행한다(dispatch.ts).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Response
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.jobs.base import JobKind, WorkerContext
from app.jobs.queue import JobQueue
from app.jobs.registry import build_registry
from app.jobs.sweeper import run_sweeper
from app.security.signing import require_hmac

log = logging.getLogger("worker")

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_KIND_RE = re.compile(r"^[a-z][a-z0-9-]{0,40}$")


def build_context(settings: Settings) -> WorkerContext:
    """실제 자원(DB 풀·Neo4j·R2·Anthropic)으로 컨텍스트를 만든다. 연결은 lifespan에서 연다."""
    from app.db import Database
    from app.graph.client import GraphClient
    from app.llm.factory import LlmFactory
    from app.llm.usage import db_usage_recorder
    from app.storage import Storage

    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL이 없습니다.")
    db = Database(settings.database_url.get_secret_value(), max_size=max(4, settings.worker_concurrency * 2))
    return WorkerContext(
        settings=settings,
        db=db,
        llm=LlmFactory(
            api_key=settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else None,
            model=settings.anthropic_model,
            record=db_usage_recorder(db),
        ),
        graph=GraphClient(settings.neo4j_uri, settings.neo4j_user, settings.neo4j_password.get_secret_value() if settings.neo4j_password else None, settings.neo4j_database),
        storage=Storage(production=settings.is_production),
    )


def _parse_job_body(body: bytes) -> tuple[str, str]:
    try:
        data: Any = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(status_code=422) from None
    # 본문은 {id, runId}만 받는다 — userId 등 다른 필드가 오면 거절한다(신원은 DB 작업 행에서만 읽는다).
    if not isinstance(data, dict) or set(data) != {"id", "runId"}:
        raise HTTPException(status_code=422)
    job_id, run_id = data["id"], data["runId"]
    if not isinstance(job_id, str) or not isinstance(run_id, str) or not _ID_RE.match(job_id) or not _ID_RE.match(run_id):
        raise HTTPException(status_code=422)
    return job_id, run_id


def configure_logging() -> None:
    """루트 로거에 처리기가 없으면 한 줄 형식으로 붙인다(uvicorn 로그와 함께 docker logs로 본다)."""
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def create_app(
    settings: Settings | None = None,
    *,
    context: WorkerContext | None = None,
    kinds: list[JobKind] | None = None,
    background: bool = True,
) -> FastAPI:
    """앱 팩토리. 설정이 틀리면(비밀값 32자 미만 등) 여기서 예외 — 워커가 시작하지 않는다.
    테스트는 context(가짜 DB 등)·kinds를 넣고 background=False로 스위퍼를 끈다."""
    configure_logging()
    settings = settings or get_settings()
    registry = build_registry(kinds)
    hmac_dep = require_hmac(settings.secret)
    state: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ctx = context or build_context(settings)
        owns = context is None
        if owns:
            await ctx.db.open()
        queue = JobQueue(ctx, registry, concurrency=settings.worker_concurrency, backlog=settings.worker_queue_backlog, enabled=settings.enabled_jobs)
        await queue.start()
        state["ctx"], state["queue"] = ctx, queue
        sweeper = (
            asyncio.create_task(run_sweeper(queue, interval_sec=settings.worker_sweep_interval_sec, older_than_sec=settings.worker_sweep_after_sec))
            if background
            else None
        )
        log.info("worker_start kinds=%s concurrency=%d", ",".join(sorted(registry)) or "-", settings.worker_concurrency)
        try:
            yield
        finally:
            if sweeper is not None:
                sweeper.cancel()
                await asyncio.gather(sweeper, return_exceptions=True)
            await queue.stop()
            if owns:
                await ctx.llm.close()
                await ctx.graph.close()
                await ctx.db.close()

    app = FastAPI(title="careerloop-worker", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.worker = state

    @app.get("/healthz", status_code=204)
    async def healthz() -> Response:
        return Response(status_code=204)

    @app.get("/readyz")
    async def readyz(_: bytes = Depends(hmac_dep)) -> JSONResponse:
        ctx: WorkerContext = state["ctx"]
        checks: dict[str, str] = {}
        try:
            await asyncio.wait_for(ctx.db.ping(), timeout=5)
            checks["db"] = "ok"
        except Exception:  # noqa: BLE001
            checks["db"] = "error"
        if ctx.graph.enabled:
            try:
                await asyncio.wait_for(ctx.graph.ping(), timeout=5)
                checks["neo4j"] = "ok"
            except Exception:  # noqa: BLE001
                checks["neo4j"] = "error"
        else:
            checks["neo4j"] = "disabled"
        ok = all(v != "error" for v in checks.values())
        queue: JobQueue = state["queue"]
        return JSONResponse({"ok": ok, **checks, "queued": queue.size, "running": queue.running}, status_code=200 if ok else 503)

    @app.post("/v1/jobs/{kind}")
    async def submit_job(kind: str, body: bytes = Depends(hmac_dep)) -> JSONResponse:
        if not _KIND_RE.match(kind):
            raise HTTPException(status_code=404)
        job_id, run_id = _parse_job_body(body)
        queue: JobQueue = state["queue"]
        try:
            result = await queue.accept(kind, job_id, run_id)
        except Exception as err:  # noqa: BLE001
            log.error("accept_failed kind=%s id=%s error=%s", kind, job_id, type(err).__name__)
            raise HTTPException(status_code=503) from None
        if result in ("queued", "duplicate"):
            log.info("job_accepted kind=%s id=%s result=%s", kind, job_id, result)
            return JSONResponse({"status": result}, status_code=202)
        if result in ("unknown_kind", "not_found"):
            raise HTTPException(status_code=404)
        if result == "unsupported_provider":
            raise HTTPException(status_code=409)
        raise HTTPException(status_code=503)

    return app
