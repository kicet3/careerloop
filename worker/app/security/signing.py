"""Vercel ↔ 워커 요청 서명(HMAC-SHA256, docs/PYTHON-WORKER.md §3.2). TS 쪽은 src/lib/worker/sign.ts이고
공유 테스트 벡터는 tests/fixtures/hmac_vectors.json이다.

서명 = HMAC-SHA256(secret, "worker.v1." + ts + "." + METHOD + "." + path + "." + sha256hex(body))
헤더: X-Worker-Timestamp(unix 초), X-Worker-Signature("v1=" + hex). 허용 오차 ±60초, 비교는 상수 시간.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import time
from typing import Literal

from fastapi import HTTPException, Request

TIMESTAMP_HEADER = "X-Worker-Timestamp"
SIGNATURE_HEADER = "X-Worker-Signature"
SIGNATURE_PREFIX = "v1="
MAX_CLOCK_SKEW_SEC = 60
#: nginx 상한(64KB)과 같다. 앱에서도 한 번 더 막는다.
MAX_BODY_BYTES = 64 * 1024

_TS_RE = re.compile(r"^[0-9]{1,12}$")
_HEX_RE = re.compile(r"^[0-9a-f]{64}$")

VerifyFailure = Literal["missing", "malformed", "expired", "mismatch"]

log = logging.getLogger("worker.auth")


def _bytes(body: str | bytes) -> bytes:
    return body.encode("utf-8") if isinstance(body, str) else body


def sha256_hex(body: str | bytes) -> str:
    return hashlib.sha256(_bytes(body)).hexdigest()


def canonical_string(ts: str, method: str, path: str, body: str | bytes) -> str:
    return f"worker.v1.{ts}.{method.upper()}.{path}.{sha256_hex(body)}"


def sign_request(secret: str, ts: str, method: str, path: str, body: str | bytes) -> str:
    mac = hmac.new(secret.encode("utf-8"), canonical_string(ts, method, path, body).encode("utf-8"), hashlib.sha256)
    return SIGNATURE_PREFIX + mac.hexdigest()


def signed_headers(secret: str, method: str, path: str, body: str | bytes, now_sec: int | None = None) -> dict[str, str]:
    """요청에 붙일 헤더(테스트·워커→Vercel 호출용)."""
    ts = str(int(time.time()) if now_sec is None else now_sec)
    return {TIMESTAMP_HEADER: ts, SIGNATURE_HEADER: sign_request(secret, ts, method, path, body)}


def verify_signature(
    secret: str,
    timestamp: str | None,
    signature: str | None,
    method: str,
    path: str,
    body: str | bytes,
    now_sec: int | None = None,
) -> VerifyFailure | None:
    """통과하면 None, 아니면 실패 사유(응답에는 싣지 않는다 — 로그용). TS verifySignature와 같다."""
    if not timestamp or not signature:
        return "missing"
    if not _TS_RE.match(timestamp) or not signature.startswith(SIGNATURE_PREFIX) or not _HEX_RE.match(signature[len(SIGNATURE_PREFIX) :]):
        return "malformed"
    now = int(time.time()) if now_sec is None else now_sec
    if abs(now - int(timestamp)) > MAX_CLOCK_SKEW_SEC:
        return "expired"
    expected = sign_request(secret, timestamp, method, path, body)
    if not hmac.compare_digest(expected.encode("ascii"), signature.encode("ascii")):
        return "mismatch"
    return None


async def read_limited_body(request: Request) -> bytes:
    """본문을 MAX_BODY_BYTES까지만 읽는다(넘으면 413)."""
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > MAX_BODY_BYTES:
                raise HTTPException(status_code=413)
        except ValueError:
            raise HTTPException(status_code=400) from None
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise HTTPException(status_code=413)
        chunks.append(chunk)
    body = b"".join(chunks)
    # 뒤의 처리(request.body())가 같은 바이트를 다시 읽을 수 있게 둔다.
    request._body = body  # noqa: SLF001
    return body


_LOG_UNSAFE = re.compile(r"[^\x21-\x7e]")
_LOG_PATH_MAX = 120


def log_safe_path(path: str) -> str:
    """로그용 경로: 출력 가능한 ASCII(공백 제외)만 남기고 나머지(CR/LF·제어 문자·공백·비ASCII)는 '?'로, 길이는 120자까지."""
    clipped = path[:_LOG_PATH_MAX]
    return _LOG_UNSAFE.sub("?", clipped) + ("…" if len(path) > _LOG_PATH_MAX else "")


def require_hmac(secret: str):
    """FastAPI 의존성: 서명이 맞지 않으면 401. 통과하면 원본 본문 바이트를 돌려준다(엔드포인트가 이것을 파싱한다)."""

    async def dependency(request: Request) -> bytes:
        body = await read_limited_body(request)
        failure = verify_signature(
            secret,
            request.headers.get(TIMESTAMP_HEADER),
            request.headers.get(SIGNATURE_HEADER),
            request.method,
            request.url.path,
            body,
        )
        if failure is not None:
            # 인증 전 경로는 공격자가 정한다(퍼센트 인코딩된 CR/LF로 로그 줄을 위조할 수 있다) — 다듬어서 남긴다.
            log.warning("auth_failed reason=%s path=%s", failure, log_safe_path(request.url.path))
            raise HTTPException(status_code=401)
        return body

    return dependency
