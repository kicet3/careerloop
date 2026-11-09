"""Neo4j 드라이버(비동기). 환경 변수는 TS src/lib/graph/client.ts와 같다: NEO4J_URI(없으면 그래프 기능 끔)·NEO4J_USER(기본 neo4j)·
NEO4J_PASSWORD·NEO4J_DATABASE(없으면 서버 기본값). 같은 Mac mini라도 TLS 이름이 맞도록 bolt+s://graph.example.com:7697을 쓴다.

워커는 그래프 제약조건·인덱스를 만들지 않는다(Vercel 쪽 ensureGraphSchema가 맡는다) — 읽기만 한다.
"""

from __future__ import annotations

from neo4j import AsyncDriver, AsyncGraphDatabase


class GraphUnavailableError(RuntimeError):
    status = 503

    def __init__(self, message: str = "경험 그래프 저장소(Neo4j)가 설정되지 않았습니다.") -> None:
        super().__init__(message)


class GraphClient:
    def __init__(self, uri: str | None, user: str | None, password: str | None, database: str | None) -> None:
        self._uri = (uri or "").strip() or None
        self._user = (user or "").strip() or "neo4j"
        self._password = password or ""
        self.database = (database or "").strip() or None
        self._driver: AsyncDriver | None = None

    @property
    def enabled(self) -> bool:
        return self._uri is not None

    def driver(self) -> AsyncDriver:
        if not self._uri:
            raise GraphUnavailableError()
        if self._driver is None:
            self._driver = AsyncGraphDatabase.driver(
                self._uri,
                auth=(self._user, self._password),
                connection_acquisition_timeout=10.0,
                max_connection_pool_size=20,
            )
        return self._driver

    async def ping(self) -> None:
        await self.driver().verify_connectivity()

    async def close(self) -> None:
        d, self._driver = self._driver, None
        if d is not None:
            await d.close()
