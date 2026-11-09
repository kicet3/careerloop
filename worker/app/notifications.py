"""앱 안 알림(notifications) 만들기 — TS src/lib/notifications/service.ts notify()·createNotification()·pruneNotifications()의 워커판.

- notify()는 던지지 않는다. 알림 실패가 작업 결과 저장을 되돌리면 안 된다(로그에는 kind와 오류 이름만 남긴다).
- user_id는 호출자가 DB 작업 행에서 읽은 값이다(요청 본문 값을 쓰지 않는다).
- 제목·본문은 한 줄로 접고 길이를 자른다(TS oneLine — UTF-16 길이). 링크는 앱 안 경로(/app...)만 남긴다(TS safeNotificationLink).
- 새 알림을 넣은 뒤 사용자당 최근 MAX_NOTIFICATIONS_PER_USER개만 남긴다.
- 실시간 알림(Supabase Realtime Broadcast, TS ./realtime.ts broadcastNotificationCreated): 환경 변수가 모두 있을 때만 알림 id를 보낸다.
  짧은 시간 제한(2초), 실패해도 던지지 않는다. 설정이 없으면 열린 탭은 예전처럼 새로고침·패널 열기 때 받는다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from app.jsutil import js_collapse_ws, js_len, js_slice, js_trim

if TYPE_CHECKING:
    from app.db import Database

log = logging.getLogger("worker.notifications")

#: TS src/lib/domain/notifications.ts와 같은 값.
MAX_NOTIFICATIONS_PER_USER = 100
MAX_NOTIFICATION_TITLE_CHARS = 120
MAX_NOTIFICATION_BODY_CHARS = 300
BROADCAST_TIMEOUT_SEC = 2.0

_NANOID_ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict"
_LINK_BAD = re.compile(r"[\s\\]")


@dataclass(frozen=True)
class NewNotification:
    kind: str
    title: str
    body: str = ""
    #: 앱 안 경로(/app/...). 그 밖의 값은 버린다.
    link: str | None = None


def strip_nul(s: str) -> str:
    # NUL 제거 + 외톨이 서로게이트 → U+FFFD(UTF-8로 쓸 수 있게 — Node가 DB에 보낼 때와 같은 결과).
    return re.sub("[\ud800-\udfff]", "\ufffd", s.replace("\u0000", ""))


def one_line(s: str, max_chars: int) -> str:
    t = js_trim(js_collapse_ws(strip_nul(s)))
    return strip_nul(f"{js_slice(t, 0, max_chars - 1)}…") if js_len(t) > max_chars else t


def safe_notification_link(raw: str | None) -> str | None:
    """TS safeNotificationLink: /app, /app/..., /app?... 만. //·공백·역슬래시가 있으면 버린다."""
    s = js_trim(raw or "")
    if not s.startswith("/app") or s.startswith("//") or _LINK_BAD.search(s):
        return None
    if s != "/app" and not s.startswith("/app/") and not s.startswith("/app?"):
        return None
    return js_slice(s, 0, 300)


def new_notification_id() -> str:
    """nanoid() 기본값과 같은 모양(21자, URL 안전 알파벳)."""
    return "".join(secrets.choice(_NANOID_ALPHABET) for _ in range(21))


_INSERT = """INSERT INTO notifications (id, user_id, kind, title, body, link, created_at)
VALUES (%(id)s, %(user_id)s, %(kind)s, %(title)s, %(body)s, %(link)s, %(created_at)s)"""

# TS pruneNotifications: 최근 keep개(created_at desc, id desc) 뒤의 것을 최대 1000개 지운다.
_PRUNE = """DELETE FROM notifications WHERE user_id = %(user_id)s AND id IN (
  SELECT id FROM notifications WHERE user_id = %(user_id)s ORDER BY created_at DESC, id DESC OFFSET %(keep)s LIMIT 1000
)"""


async def create_notification(db: Database, user_id: str, n: NewNotification, now: datetime | None = None) -> str:
    """알림을 만들고 오래된 것을 정리한다. 실패하면 던진다(작업 경로에서는 notify()를 쓴다). 만든 알림 id."""
    if not user_id:
        raise ValueError("user_id가 없습니다")
    nid = new_notification_id()
    await db.execute(
        _INSERT,
        {
            "id": nid,
            "user_id": user_id,
            "kind": n.kind,
            "title": one_line(n.title, MAX_NOTIFICATION_TITLE_CHARS) or "알림",
            "body": one_line(n.body or "", MAX_NOTIFICATION_BODY_CHARS),
            "link": safe_notification_link(n.link),
            "created_at": now or datetime.now(UTC),
        },
    )
    await db.execute(_PRUNE, {"user_id": user_id, "keep": MAX_NOTIFICATIONS_PER_USER})
    await broadcast_notification_created(user_id, nid)
    return nid


async def notify(db: Database, user_id: str, n: NewNotification) -> None:
    """백그라운드 작업용: 알림을 만들되 실패해도 던지지 않는다."""
    try:
        await create_notification(db, user_id, n)
    except Exception as err:  # noqa: BLE001 — 알림 실패는 작업 결과에 영향을 주지 않는다
        log.error("notify_failed kind=%s error=%s", n.kind, type(err).__name__)


# ---------------------------------------------------------------------------
# 실시간 알림(Supabase Realtime Broadcast)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RealtimeConfig:
    url: str
    service_key: str


def _pick(env: dict[str, str] | os._Environ[str], *names: str) -> str | None:
    for name in names:
        v = (env.get(name) or "").strip()
        if v:
            return v
    return None


def realtime_config(env: dict[str, str] | None = None) -> RealtimeConfig | None:
    """TS realtimeConfig와 같은 켜짐 조건(주소·공개 키·서버 키·서명 키가 모두 있을 때). 워커는 Broadcast만 하므로 서명 키 내용은 쓰지 않는다."""
    e = os.environ if env is None else env
    raw_url = _pick(e, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL")
    anon = _pick(e, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY")
    service = _pick(e, "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY")
    signer = _pick(e, "SUPABASE_REALTIME_JWK", "SUPABASE_JWT_SECRET")
    if not raw_url or not anon or not service or not signer:
        return None
    try:
        u = urlsplit(raw_url)
    except ValueError:
        return None
    if u.scheme not in ("https", "http") or not u.hostname:
        return None
    return RealtimeConfig(url=f"{u.scheme}://{u.netloc}", service_key=service)


def _is_jwt(key: str) -> bool:
    return len(key.split(".")) == 3 and key.startswith("eyJ")


def _post_broadcast(cfg: RealtimeConfig, body: bytes) -> int:
    headers = {"apikey": cfg.service_key, "Content-Type": "application/json"}
    if _is_jwt(cfg.service_key):
        headers["Authorization"] = f"Bearer {cfg.service_key}"
    req = urllib.request.Request(f"{cfg.url}/realtime/v1/api/broadcast", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=BROADCAST_TIMEOUT_SEC) as res:  # noqa: S310 — 설정한 Supabase 주소만
        return int(res.status)


async def broadcast_notification_created(user_id: str, notification_id: str, env: dict[str, str] | None = None) -> bool:
    """새 알림 id만 비공개 채널 notifications:<user_id>로 보낸다. 설정이 없으면 아무것도 하지 않는다. 절대 던지지 않는다."""
    try:
        cfg = realtime_config(env)
        if cfg is None:
            return False
        body = json.dumps(
            {"messages": [{"topic": f"notifications:{user_id}", "event": "notification", "payload": {"id": notification_id}, "private": True}]},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        status = await asyncio.wait_for(asyncio.to_thread(_post_broadcast, cfg, body), timeout=BROADCAST_TIMEOUT_SEC + 0.5)
        return 200 <= status < 300
    except Exception as err:  # noqa: BLE001
        log.error("realtime_broadcast_failed error=%s", type(err).__name__)
        return False
