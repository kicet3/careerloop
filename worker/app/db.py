"""Postgres 연결(psycopg 3 async pool). 스키마의 주인은 Prisma 마이그레이션이다 — 워커는 같은 표를 SQL로 읽고 쓰며 스키마를 바꾸지 않는다.

DATABASE_URL 해석은 TS src/lib/db/config.ts pgConnectionConfig와 같은 규칙이다.
- Prisma 전용 쿼리 매개변수(pgbouncer·connection_limit·pool_timeout·schema·uselibpqcompat)는 libpq가 모르므로 뺀다. ?schema=는 search_path로 옮긴다.
- sslmode가 없고 로컬 호스트가 아니면 sslmode=require(암호화, 인증서 체인은 검증하지 않음 — Supabase 풀러 인증서). verify-full/verify-ca는 그대로 둔다.
- Supabase Transaction pooler(6543)는 서버 측 prepared statement를 지원하지 않으므로 prepare_threshold=None으로 둔다.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

_PRISMA_ONLY = {"uselibpqcompat", "pgbouncer", "connection_limit", "pool_timeout", "schema"}
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


def _is_local(host: str | None) -> bool:
    h = (host or "").lower()
    return h in _LOCAL_HOSTS or h.startswith("127.")


def libpq_conninfo(url: str) -> tuple[str, str | None]:
    """Prisma 형식 DATABASE_URL → (libpq 주소, search_path로 쓸 schema)."""
    parts = urlsplit(url)
    if parts.scheme not in ("postgres", "postgresql"):
        raise ValueError("DATABASE_URL은 postgres:// 또는 postgresql:// 주소여야 합니다.")
    query = parse_qsl(parts.query, keep_blank_values=True)
    schema = next((v for k, v in query if k == "schema" and v), None)
    mode = next((v.lower() for k, v in query if k == "sslmode"), None)
    kept = [(k, v) for k, v in query if k not in _PRISMA_ONLY and k != "sslmode"]
    if mode in ("verify-full", "verify-ca", "disable"):
        kept.append(("sslmode", mode))
    elif mode is None and _is_local(parts.hostname):
        pass  # 로컬은 sslmode가 없으면 평문
    else:
        kept.append(("sslmode", "require"))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), "")), schema


def describe_database_url(url: str) -> str:
    """로그용 주소 표시(비밀번호 없음)."""
    try:
        p = urlsplit(url)
        return f"{p.hostname}{f':{p.port}' if p.port else ''}{p.path}"
    except ValueError:
        return "(해석할 수 없는 주소)"


class Database:
    """연결 풀. open()·close()는 앱 수명 주기(lifespan)에서 부른다."""

    def __init__(self, url: str, *, min_size: int = 1, max_size: int = 8) -> None:
        conninfo, schema = libpq_conninfo(url)
        kwargs: dict[str, Any] = {"prepare_threshold": None, "row_factory": dict_row, "autocommit": True}
        if schema:
            kwargs["options"] = f"-c search_path={schema}"
        self._pool = AsyncConnectionPool(conninfo, min_size=min_size, max_size=max_size, kwargs=kwargs, open=False, timeout=10)

    async def open(self) -> None:
        await self._pool.open(wait=False)

    async def close(self) -> None:
        await self._pool.close()

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[AsyncConnection]:
        """autocommit 연결. 여러 문장을 한 트랜잭션으로 묶으려면 `async with conn.transaction():`."""
        async with self._pool.connection() as conn:
            yield conn

    async def fetchone(self, sql: str, params: tuple | dict | None = None) -> dict | None:
        async with self.connection() as conn:
            cur = await conn.execute(sql, params)
            return await cur.fetchone()

    async def fetchall(self, sql: str, params: tuple | dict | None = None) -> list[dict]:
        async with self.connection() as conn:
            cur = await conn.execute(sql, params)
            return list(await cur.fetchall())

    async def execute(self, sql: str, params: tuple | dict | None = None) -> int:
        """영향받은 행 수."""
        async with self.connection() as conn:
            cur = await conn.execute(sql, params)
            return cur.rowcount

    async def ping(self) -> None:
        await self.fetchone("SELECT 1 AS ok")
