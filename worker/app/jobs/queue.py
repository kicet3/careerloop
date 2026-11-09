"""워커 안의 async 작업 큐(docs/PYTHON-WORKER.md §3.4).

- 같은 (kind, id, runId)가 큐에 있거나 실행 중이면 다시 넣지 않는다(멱등 — 그대로 202).
- 동시 실행 수는 WORKER_CONCURRENCY(기본 4). 받아 두는 수는 실행 수 + WORKER_QUEUE_BACKLOG(기본 0)까지다 — 넘으면 'full'(→ 503,
  Vercel이 직접 실행). 작업의 시간 상한은 작업 행의 started_at부터 재므로 큐에서 기다린 시간도 상한을 깎는다. 그래서 오래 기다리게
  받아 두지 않고(202를 주면 Vercel fallback이 돌지 않는다), 빈 자리가 없으면 바로 Vercel로 돌려보낸다.
- accept(): 엔드포인트와 스위퍼가 함께 쓰는 입구. precheck로 DB 작업 행을 읽어 실행할 수 있는 행인지·엔진이 'anthropic'인지 확인한다.
  precheck는 PRECHECK_TIMEOUT_SEC 안에 끝나야 한다(넘으면 TimeoutError → 503) — Vercel 디스패치 타임아웃(5초)이 지나 Vercel이
  직접 실행하기 시작한 뒤에 워커도 같은 작업을 받는 일을 줄인다. 그래도 겹치면 각 작업의 시작 선점(조건부 UPDATE)이 한쪽만 실행하게 한다.
- 워커가 재시작되면 큐의 작업은 사라진다. 다시 집을 수 있는 종류는 스위퍼가(sweep_query), 나머지는 기존 stale 규칙이 처리한다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Literal

from app.config import is_job_enabled
from app.jobs.base import JobKind, WorkerContext
from app.llm.types import WORKER_PROVIDER

log = logging.getLogger("worker.jobs")

SubmitResult = Literal["queued", "duplicate", "full"]
AcceptResult = Literal["queued", "duplicate", "full", "unknown_kind", "not_found", "unsupported_provider"]

Key = tuple[str, str, str]

#: precheck(DB 작업 행 읽기) 시간 상한(초). Vercel 디스패치 타임아웃(src/lib/worker/dispatch.ts DISPATCH_TIMEOUT_MS = 5초)보다 충분히 짧게.
PRECHECK_TIMEOUT_SEC = 2.5


@dataclass(frozen=True)
class _Item:
    kind: JobKind
    job_id: str
    run_id: str
    enqueued_at: float


class JobQueue:
    def __init__(
        self,
        ctx: WorkerContext,
        kinds: dict[str, JobKind],
        *,
        concurrency: int,
        backlog: int = 0,
        enabled: list[str] | None = None,
        precheck_timeout_sec: float = PRECHECK_TIMEOUT_SEC,
    ) -> None:
        self.ctx = ctx
        self.kinds = kinds
        self._enabled = enabled if enabled is not None else ["*"]
        self._concurrency = concurrency
        #: 받아 두는 상한(실행 중 + 대기). 넘으면 'full'.
        self._capacity = concurrency + max(0, backlog)
        self._precheck_timeout_sec = precheck_timeout_sec
        self._queue: asyncio.Queue[_Item] = asyncio.Queue()
        self._keys: set[Key] = set()
        self._workers: list[asyncio.Task[None]] = []
        self._running = 0

    # --- 상태 ---------------------------------------------------------------

    def kind_enabled(self, name: str) -> JobKind | None:
        k = self.kinds.get(name)
        return k if k is not None and is_job_enabled(self._enabled, name) else None

    def active(self, kind: str, job_id: str, run_id: str) -> bool:
        return (kind, job_id, run_id) in self._keys

    @property
    def size(self) -> int:
        return len(self._keys)

    @property
    def running(self) -> int:
        return self._running

    # --- 넣기 ---------------------------------------------------------------

    def submit(self, kind: JobKind, job_id: str, run_id: str) -> SubmitResult:
        key = (kind.name, job_id, run_id)
        if key in self._keys:
            return "duplicate"
        # 실행 중 + 대기가 상한이면 받지 않는다(기다리는 동안 시간 상한이 깎이고, 202를 주면 Vercel fallback이 돌지 않는다).
        if len(self._keys) >= self._capacity:
            return "full"
        self._queue.put_nowait(_Item(kind, job_id, run_id, time.monotonic()))
        self._keys.add(key)
        return "queued"

    async def accept(self, kind_name: str, job_id: str, run_id: str) -> AcceptResult:
        """DB 작업 행 확인 후 넣는다. DB 오류는 그대로 던진다(엔드포인트가 503)."""
        kind = self.kind_enabled(kind_name)
        if kind is None:
            return "unknown_kind"
        if self.active(kind.name, job_id, run_id):
            return "duplicate"
        # 자리가 없으면 DB를 읽기 전에 돌려보낸다(precheck 비용·지연 없이 바로 503).
        if len(self._keys) >= self._capacity:
            return "full"
        ref = await asyncio.wait_for(kind.precheck(self.ctx, job_id, run_id), timeout=self._precheck_timeout_sec)
        if ref is None or ref.id != job_id or ref.run_id != run_id:
            return "not_found"
        if ref.provider != WORKER_PROVIDER:
            return "unsupported_provider"
        return self.submit(kind, job_id, run_id)

    # --- 실행 ---------------------------------------------------------------

    async def start(self) -> None:
        if self._workers:
            return
        self._workers = [asyncio.create_task(self._worker(i), name=f"job-worker-{i}") for i in range(self._concurrency)]

    async def stop(self) -> None:
        for t in self._workers:
            t.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []

    async def join(self) -> None:
        """테스트용: 큐가 빌 때까지 기다린다."""
        await self._queue.join()

    async def _worker(self, index: int) -> None:
        while True:
            item = await self._queue.get()
            key = (item.kind.name, item.job_id, item.run_id)
            started = time.monotonic()
            self._running += 1
            try:
                log.info("job_start kind=%s id=%s waited_ms=%d", item.kind.name, item.job_id, int((started - item.enqueued_at) * 1000))
                await item.kind.run(self.ctx, item.job_id, item.run_id)
                log.info("job_done kind=%s id=%s ms=%d", item.kind.name, item.job_id, int((time.monotonic() - started) * 1000))
            except asyncio.CancelledError:
                log.warning("job_cancelled kind=%s id=%s ms=%d", item.kind.name, item.job_id, int((time.monotonic() - started) * 1000))
                raise
            except Exception as err:  # noqa: BLE001 — 작업 하나의 실패가 워커를 멈추지 않게
                # 오류 메시지에는 본문이 섞일 수 있어 이름만 남긴다.
                log.error("job_error kind=%s id=%s ms=%d error=%s", item.kind.name, item.job_id, int((time.monotonic() - started) * 1000), type(err).__name__)
            finally:
                self._running -= 1
                self._keys.discard(key)
                self._queue.task_done()
