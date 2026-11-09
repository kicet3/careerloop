"""app/notifications.py(TS notifications/service.ts notify의 워커판) — 문구 정리·링크 거르기·던지지 않기."""

from __future__ import annotations

from typing import Any

from app.notifications import NewNotification, notify, one_line, realtime_config, safe_notification_link
from tests.fakes import FakeDb


def test_safe_link_matches_ts_rules() -> None:
    assert safe_notification_link("/app/interview/s1") == "/app/interview/s1"
    assert safe_notification_link(" /app ") == "/app"
    assert safe_notification_link("/app?x=1") == "/app?x=1"
    for bad in ("//evil.com/app", "/apps", "https://x/app", "/app/a b", "/app\\x", None, ""):
        assert safe_notification_link(bad) is None


def test_one_line_clips_utf16() -> None:
    assert one_line(" a\n\tb\u0000 ", 10) == "a b"
    # JS slice처럼 UTF-16 119단위에서 자르면 서로게이트 쌍이 갈린다 — DB에 쓸 수 있게 U+FFFD로(Node UTF-8 인코딩과 같은 결과).
    assert one_line("😀" * 61, 120) == "😀" * 59 + "\ufffd" + "…"


def test_realtime_off_without_env() -> None:
    assert realtime_config({}) is None
    env = {"SUPABASE_URL": "https://p.supabase.co/x", "SUPABASE_ANON_KEY": "a", "SUPABASE_SERVICE_ROLE_KEY": "s", "SUPABASE_JWT_SECRET": "j"}
    cfg = realtime_config(env)
    assert cfg is not None and cfg.url == "https://p.supabase.co"


async def test_notify_inserts_then_prunes_and_never_throws() -> None:
    calls: list[tuple[str, Any]] = []
    db = FakeDb(lambda sql, params: calls.append((sql, params)) or 1)
    await notify(db, "u1", NewNotification(kind="interview-ready", title="제목\n둘", body="b", link="/app/interview/s1"))  # type: ignore[arg-type]
    assert "INSERT INTO notifications" in calls[0][0]
    assert calls[0][1]["user_id"] == "u1" and calls[0][1]["title"] == "제목 둘" and calls[0][1]["link"] == "/app/interview/s1"
    assert "DELETE FROM notifications" in calls[1][0] and calls[1][1] == {"user_id": "u1", "keep": 100}

    def boom(sql: str, params: Any) -> int:
        raise ConnectionError("db down")

    await notify(FakeDb(boom), "u1", NewNotification(kind="interview-failed", title="t"))  # type: ignore[arg-type]
