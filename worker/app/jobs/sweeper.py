"""스위퍼(docs/PYTHON-WORKER.md §3.4): WORKER_SWEEP_INTERVAL_SEC(기본 60초)마다 켜진 종류의 sweep_query를 돌려
'queued'인 채 WORKER_SWEEP_AFTER_SEC(기본 120초) 넘게 아무도 집지 않은 작업을 다시 집는다(디스패치 유실 대비).
다시 집을 때도 accept()를 지나므로 precheck·엔진 확인을 다시 한다. 실행 시작은 각 작업의 조건부 UPDATE가 한 번만 이기게 한다.
"""

from __future__ import annotations

import asyncio
import logging

from app.jobs.queue import JobQueue

log = logging.getLogger("worker.sweeper")

SWEEP_LIMIT = 20


async def sweep_once(queue: JobQueue, *, older_than_sec: int, limit: int = SWEEP_LIMIT) -> int:
    """한 바퀴. 새로 넣은 작업 수."""
    picked = 0
    for name, kind in queue.kinds.items():
        if kind.sweep_query is None or queue.kind_enabled(name) is None:
            continue
        try:
            rows = await queue.ctx.db.fetchall(kind.sweep_query, {"older_than_sec": older_than_sec, "limit": limit})
        except Exception as err:  # noqa: BLE001
            log.error("sweep_query_failed kind=%s error=%s", name, type(err).__name__)
            continue
        for row in rows:
            job_id, run_id = row.get("id"), row.get("run_id")
            if not isinstance(job_id, str) or not isinstance(run_id, str):
                continue
            try:
                result = await queue.accept(name, job_id, run_id)
            except Exception as err:  # noqa: BLE001
                log.error("sweep_accept_failed kind=%s id=%s error=%s", name, job_id, type(err).__name__)
                continue
            if result == "queued":
                picked += 1
                log.info("sweep_picked kind=%s id=%s", name, job_id)
            elif result == "full":
                return picked
    return picked


async def run_sweeper(queue: JobQueue, *, interval_sec: float, older_than_sec: int) -> None:
    while True:
        await asyncio.sleep(interval_sec)
        try:
            await sweep_once(queue, older_than_sec=older_than_sec)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            log.error("sweep_failed error=%s", type(err).__name__)
