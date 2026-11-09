"""테스트용 가짜 자원(DB·그래프·저장소)과 컨텍스트 만들기."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.config import Settings
from app.jobs.base import WorkerContext

SECRET = "0123456789abcdef0123456789abcdef-test-secret"


class FakeDb:
    """SQL 문자열을 보고 handler가 답한다. 실행한 (sql, params)를 기록한다."""

    def __init__(self, handler: Callable[[str, Any], list[dict[str, Any]] | int | None] | None = None) -> None:
        self.handler = handler or (lambda sql, params: [])
        self.calls: list[tuple[str, Any]] = []
        self.fail_ping = False

    async def open(self) -> None: ...
    async def close(self) -> None: ...

    async def fetchone(self, sql: str, params: Any = None) -> dict[str, Any] | None:
        self.calls.append((sql, params))
        rows = self.handler(sql, params)
        return rows[0] if isinstance(rows, list) and rows else None

    async def fetchall(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        self.calls.append((sql, params))
        rows = self.handler(sql, params)
        return rows if isinstance(rows, list) else []

    async def execute(self, sql: str, params: Any = None) -> int:
        self.calls.append((sql, params))
        r = self.handler(sql, params)
        return r if isinstance(r, int) else 0

    async def ping(self) -> None:
        if self.fail_ping:
            raise ConnectionError("db down")


class FakeGraph:
    enabled = False
    database = None

    async def ping(self) -> None: ...
    async def close(self) -> None: ...


class FakeLlmFactory:
    model = "fake"

    async def close(self) -> None: ...


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {"worker_shared_secret": SECRET, "database_url": "postgresql://u:p@127.0.0.1:5432/db"}
    base.update(overrides)
    return Settings(**base)


def make_context(db: FakeDb | None = None, settings: Settings | None = None) -> WorkerContext:
    return WorkerContext(
        settings=settings or make_settings(),
        db=db or FakeDb(),  # type: ignore[arg-type]
        llm=FakeLlmFactory(),  # type: ignore[arg-type]
        graph=FakeGraph(),  # type: ignore[arg-type]
        storage=None,  # type: ignore[arg-type]
    )
