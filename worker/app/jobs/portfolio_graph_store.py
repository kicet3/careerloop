"""경험 그래프 포트폴리오(portfolios.kind = 'graph') 저장 — TS src/lib/portfolios/service.ts createGraphPortfolio·replacePortfolioText·
deletePortfolio(+ shares.ts deleteShareRateEvents)를 작업 실행에 필요한 만큼 옮긴 것.

- 모든 SQL은 user_id 조건을 건다(작업 행에서 읽은 user_id만 받는다). 남의 포트폴리오는 None.
- 저장소 키는 users/<user_id>/portfolios/<id>/text-<꼬리>.txt(TS portfolioTextKey와 같은 규칙). 업로드마다 새 키를 쓴다.
- 본문 바꾸기는 compare-and-swap(행이 '읽은 옛 키'를 그대로 가리킬 때만)이고, commit 확인(작업 완료 기록)과 같은 트랜잭션에서 한다.
"""

from __future__ import annotations

import logging
import re
import secrets
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from app.jobs.base import WorkerContext
from app.jobs.portfolio_graph_output import count_portfolio_add_markers
from app.jsutil import js_len, js_slice, js_trim
from app.storage import assert_user_key, user_key, user_prefix

log = logging.getLogger("worker.jobs.portfolio_graph")

#: TS src/lib/domain/portfolios.ts와 같은 상한.
MAX_PORTFOLIO_TITLE_CHARS = 120
MAX_PORTFOLIO_DESCRIPTION_CHARS = 2000
MAX_PORTFOLIO_TEXT_CHARS = 60_000

_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"

#: TS src/lib/auth/db-rate-limit.ts SHARE_CHAT_IP_LIMIT·SHARE_CHAT_TOKEN_DAILY_LIMIT의 bucket.
_SHARE_CHAT_IP_BUCKET = "share-chat-ip"
_SHARE_CHAT_TOKEN_BUCKET = "share-chat-token"


def now_utc() -> datetime:
    """TS new Date()와 같은 밀리초 정밀도(timestamptz(3))."""
    t = datetime.now(UTC)
    return t.replace(microsecond=t.microsecond // 1000 * 1000)


def strip_nul(s: str) -> str:
    """NUL 제거(TS stripNul) + 외톨이 서로게이트 → U+FFFD(psycopg가 UTF-8로 보낼 수 있게 — Node와 같은 결과)."""
    return well_formed(s.replace("\u0000", ""))


def strip_nul_deep(v: Any) -> Any:
    """TS stripNulDeep: JSON 값 안의 모든 문자열·키에서 NUL을 지운다(jsonb는 \\u0000을 받지 않는다)."""
    if isinstance(v, str):
        return strip_nul(v)
    if isinstance(v, list):
        return [strip_nul_deep(x) for x in v]
    if isinstance(v, dict):
        return {strip_nul(k) if isinstance(k, str) else k: strip_nul_deep(x) for k, x in v.items()}
    return v


def well_formed(s: str) -> str:
    """외톨이 서로게이트(UTF-16 단위로 자른 끝)를 U+FFFD로 — JS가 UTF-8로 쓸 때(Buffer.from)와 같다."""
    return _LONE_SURROGATE.sub("�", s)


def new_portfolio_id() -> str:
    """TS customAlphabet(영문·숫자, 16)."""
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(16))


def _base36(n: int) -> str:
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = _B36[r] + out
        if n == 0:
            return out


def new_nonce() -> str:
    """TS newNonce: Date.now().toString(36) + UUID 앞 8자."""
    return f"{_base36(int(time.time() * 1000))}{uuid.uuid4().hex[:8]}"


def portfolio_text_key(user_id: str, portfolio_id: str, nonce: str | None = None) -> str:
    return user_key(user_id, "portfolios", portfolio_id, f"text-{nonce or new_nonce()}.txt")


def clean_title(raw: str | None) -> str:
    return js_trim(js_slice(strip_nul(js_trim(raw or "")), 0, MAX_PORTFOLIO_TITLE_CHARS))


def clean_text(raw: str) -> tuple[str, bool]:
    """(본문, 잘렸는가). 길이는 UTF-16 단위."""
    clean = js_trim(strip_nul(raw))
    truncated = js_len(clean) > MAX_PORTFOLIO_TEXT_CHARS
    return (js_slice(clean, 0, MAX_PORTFOLIO_TEXT_CHARS) if truncated else clean), truncated


def source_json(source: dict[str, Any], text: str) -> dict[str, Any]:
    """TS sourceJson(portfolios.graph_source)."""
    return {
        "projectIds": list(source["projectIds"])[:50],
        "postingId": source["postingId"],
        "notes": js_slice(strip_nul(source["notes"]), 0, 2000),
        "missingInfo": [js_slice(strip_nul(m), 0, 500) for m in source["missingInfo"]][:50],
        "generatedAt": source["generatedAt"],
        "addMarkers": count_portfolio_add_markers(text),
        "templateId": source.get("templateId"),
    }


async def _drop_text(ctx: WorkerContext, user_id: str, key: str | None) -> None:
    if not key:
        return
    try:
        await ctx.storage.delete_object(assert_user_key(user_id, key))
    except Exception as err:  # noqa: BLE001 — TS dropText처럼 로그만
        log.error("portfolio_text_delete_failed error=%s", type(err).__name__)


_OWNED_ROW = "SELECT id, kind, text_key, original_key FROM portfolios WHERE id = %(id)s AND user_id = %(user_id)s"
_INSERT_PORTFOLIO = """INSERT INTO portfolios (id, user_id, title, description, kind, text_key, chars, graph_source, created_at, updated_at)
VALUES (%(id)s, %(user_id)s, %(title)s, NULL, 'graph', %(text_key)s, %(chars)s, %(graph_source)s, %(now)s, %(now)s)"""


async def create_graph_portfolio(ctx: WorkerContext, user_id: str, *, title: str, text: str, source: dict[str, Any]) -> str:
    """AI가 쓴 본문으로 새 'graph' 포트폴리오. 본문을 먼저 저장하고 행을 만든다(실패하면 본문을 지운다). 만든 포트폴리오 id."""
    pid = new_portfolio_id()
    body, _ = clean_text(text)
    key = portfolio_text_key(user_id, pid)
    await ctx.storage.put_object(key, well_formed(body), "text/markdown; charset=utf-8")
    try:
        await ctx.db.execute(
            _INSERT_PORTFOLIO,
            {
                "id": pid,
                "user_id": user_id,
                "title": well_formed(clean_title(title) or "경험 그래프 포트폴리오"),
                "text_key": key,
                "chars": js_len(body),
                "graph_source": Jsonb(strip_nul_deep(source_json(source, body))),
                "now": now_utc(),
            },
        )
    except BaseException:
        await _drop_text(ctx, user_id, key)
        raise
    return pid


ReplaceResult = Literal["ok", "not_found", "not_graph", "conflict", "aborted"]
CommitFn = Callable[[AsyncConnection], Awaitable[bool]]


class _ReplaceAborted(Exception):
    pass


@dataclass(frozen=True)
class ReplaceOutcome:
    result: ReplaceResult
    portfolio_id: str | None = None


_CAS_UPDATE = """UPDATE portfolios SET text_key = %(key)s, chars = %(chars)s, updated_at = %(now)s, graph_source = %(graph_source)s
WHERE id = %(id)s AND user_id = %(user_id)s AND kind = 'graph' AND text_key IS NOT DISTINCT FROM %(old_key)s"""


async def replace_portfolio_text(ctx: WorkerContext, user_id: str, portfolio_id: str, raw_text: str, *, source: dict[str, Any], commit: CommitFn) -> ReplaceOutcome:
    """TS replacePortfolioText(source·commit을 주는 다시 만들기 경로). 새 키에 저장 → 한 트랜잭션에서 compare-and-swap + commit 확인 → 옛 본문 삭제."""
    row = await ctx.db.fetchone(_OWNED_ROW, {"id": portfolio_id, "user_id": user_id})
    if not row:
        return ReplaceOutcome("not_found")
    if row["kind"] != "graph":
        return ReplaceOutcome("not_graph")
    body, _ = clean_text(raw_text)
    graph_source = Jsonb(strip_nul_deep(source_json(source, body)))
    key = portfolio_text_key(user_id, portfolio_id)
    await ctx.storage.put_object(key, well_formed(body), "text/markdown; charset=utf-8")
    updated = False
    try:
        async with ctx.db.connection() as conn, conn.transaction():
            cur = await conn.execute(
                _CAS_UPDATE,
                {"key": key, "chars": js_len(body), "now": now_utc(), "graph_source": graph_source, "id": portfolio_id, "user_id": user_id, "old_key": row["text_key"]},
            )
            if cur.rowcount > 0:
                updated = True
                if not await commit(conn):
                    raise _ReplaceAborted()
    except _ReplaceAborted:
        await _drop_text(ctx, user_id, key)
        return ReplaceOutcome("aborted")
    except BaseException:
        await _drop_text(ctx, user_id, key)
        raise
    if not updated:
        await _drop_text(ctx, user_id, key)
        current = await ctx.db.fetchone(_OWNED_ROW, {"id": portfolio_id, "user_id": user_id})
        if not current:
            return ReplaceOutcome("not_found")
        return ReplaceOutcome("conflict" if current["kind"] == "graph" else "not_graph")
    old = row["text_key"]
    if old and old != key:
        await _drop_text(ctx, user_id, old)
    return ReplaceOutcome("ok", portfolio_id)


async def discard_portfolio(ctx: WorkerContext, user_id: str, portfolio_id: str) -> None:
    """버려진 실행이 만든 포트폴리오를 지운다(TS deletePortfolio). 실패해도 던지지 않는다."""
    try:
        row = await ctx.db.fetchone(_OWNED_ROW, {"id": portfolio_id, "user_id": user_id})
        if not row:
            return
        shares = await ctx.db.fetchall("SELECT id FROM portfolio_shares WHERE portfolio_id = %(id)s AND user_id = %(user_id)s", {"id": portfolio_id, "user_id": user_id})
        share_ids = [s["id"] for s in shares]
        count = await ctx.db.execute("DELETE FROM portfolios WHERE id = %(id)s AND user_id = %(user_id)s", {"id": portfolio_id, "user_id": user_id})
        if count == 0:
            return
        if share_ids:
            try:
                await ctx.db.execute(
                    "DELETE FROM rate_events WHERE (bucket = %(ip)s AND split_part(key, ':', 1) = ANY(%(ids)s) AND key LIKE '%%:%%') "
                    "OR (bucket = %(token)s AND key = ANY(%(ids)s))",
                    {"ip": _SHARE_CHAT_IP_BUCKET, "token": _SHARE_CHAT_TOKEN_BUCKET, "ids": share_ids},
                )
            except Exception as err:  # noqa: BLE001
                log.error("share_rate_events_delete_failed error=%s", type(err).__name__)
        try:
            keys = {k for k in (row["text_key"], row["original_key"]) if k}
            keys.update(await ctx.storage.list_by_prefix(user_prefix(user_id, "portfolios", portfolio_id)))
            for k in keys:
                await ctx.storage.delete_object(assert_user_key(user_id, k))
        except Exception as err:  # noqa: BLE001
            log.error("portfolio_objects_delete_failed id=%s error=%s", portfolio_id, type(err).__name__)
    except Exception as err:  # noqa: BLE001 — TS discardPortfolio처럼 로그만
        log.error("portfolio_discard_failed id=%s error=%s", portfolio_id, type(err).__name__)
