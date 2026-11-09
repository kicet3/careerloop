"""오브젝트 저장소(R2, S3 호환). 환경 변수와 키 규칙은 TS src/lib/storage/index.ts와 같다.

- R2_ACCOUNT_ID·R2_ACCESS_KEY_ID·R2_SECRET_ACCESS_KEY·R2_BUCKET이 모두 있으면 R2(R2_ENDPOINT가 없으면 https://<account>.r2.cloudflarestorage.com).
- 없으면 APP_ENV=PRODUCTION에서는 StorageConfigError, 그 밖(로컬 개발)은 STORAGE_DIR(기본 ./data/storage) 파일.
- 키: users/<userId>/..., shared-postings/<id>/..., uploads/<userId>/... 형식만. 조각은 영문·숫자·._- 만, '.'·'..' 금지.
- 사용자 자료를 읽을 때는 assert_user_key로 키가 그 사용자 접두사 아래인지 코드로 확인한다(다른 사용자 자료 격리).
boto3는 동기 API라 asyncio.to_thread로 부른다.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.jsutil import well_formed, well_formed_deep

STORAGE_ROOTS = ("users", "shared-postings", "uploads")
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$")
MAX_KEY_LENGTH = 512


class StorageKeyError(ValueError):
    status = 400

    def __init__(self, message: str = "잘못된 저장소 키입니다.") -> None:
        super().__init__(message)


class StorageConfigError(RuntimeError):
    status = 503

    def __init__(self, message: str = "저장소(R2)가 설정되지 않았습니다. APP_ENV=PRODUCTION에서는 로컬 저장소를 쓰지 않습니다.") -> None:
        super().__init__(message)


def assert_valid_key(key: str, *, prefix: bool = False) -> None:
    if not isinstance(key, str) or not key or len(key) > MAX_KEY_LENGTH:
        raise StorageKeyError()
    parts = key.split("/")
    if prefix and parts[-1] == "":
        parts.pop()
    if parts[0] not in STORAGE_ROOTS or len(parts) < (2 if prefix else 3):
        raise StorageKeyError("키는 users/<userId>/..., shared-postings/<id>/... 또는 uploads/<userId>/... 형식이어야 합니다.")
    for p in parts:
        if not _SEGMENT_RE.match(p) or p in (".", "..") or ".." in p:
            raise StorageKeyError()


def user_key(user_id: str, *parts: str) -> str:
    key = "/".join(["users", user_id, *parts])
    assert_valid_key(key)
    return key


def user_prefix(user_id: str, *parts: str) -> str:
    key = "/".join(["users", user_id, *parts]) + "/"
    assert_valid_key(key, prefix=True)
    return key


def shared_posting_key(shared_posting_id: str, *parts: str) -> str:
    key = "/".join(["shared-postings", shared_posting_id, *parts])
    assert_valid_key(key)
    return key


def assert_user_key(user_id: str, key: str) -> str:
    """key가 users/<user_id>/ 아래인지 확인한다(DB 행에 적힌 키라도 다른 사용자 접두사면 막는다)."""
    assert_valid_key(key)
    if not user_id or not key.startswith(f"users/{user_id}/"):
        raise StorageKeyError("다른 사용자의 저장소 키입니다.")
    return key


@dataclass(frozen=True)
class R2Config:
    endpoint: str
    access_key_id: str
    secret_access_key: str
    bucket: str


def r2_config(env: dict[str, str] | None = None) -> R2Config | None:
    e = os.environ if env is None else env
    get = lambda k: (e.get(k) or "").strip()  # noqa: E731
    account, key_id, secret, bucket = get("R2_ACCOUNT_ID"), get("R2_ACCESS_KEY_ID"), get("R2_SECRET_ACCESS_KEY"), get("R2_BUCKET")
    if not (account and key_id and secret and bucket):
        return None
    return R2Config(get("R2_ENDPOINT") or f"https://{account}.r2.cloudflarestorage.com", key_id, secret, bucket)


class _R2Backend:
    kind = "r2"

    def __init__(self, cfg: R2Config) -> None:
        import boto3
        from botocore.config import Config

        self._bucket = cfg.bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=cfg.endpoint,
            aws_access_key_id=cfg.access_key_id,
            aws_secret_access_key=cfg.secret_access_key,
            region_name="auto",
            config=Config(retries={"max_attempts": 4, "mode": "standard"}, request_checksum_calculation="when_required", response_checksum_validation="when_required"),
        )

    @staticmethod
    def _missing(e: Exception) -> bool:
        code = getattr(e, "response", {}).get("Error", {}).get("Code") if hasattr(e, "response") else None
        return code in ("NoSuchKey", "404", "NotFound")

    def put(self, key: str, body: bytes, content_type: str | None) -> None:
        extra: dict[str, Any] = {"ContentType": content_type} if content_type else {}
        self._client.put_object(Bucket=self._bucket, Key=key, Body=body, **extra)

    def get(self, key: str) -> bytes | None:
        try:
            return self._client.get_object(Bucket=self._bucket, Key=key)["Body"].read()
        except Exception as e:  # botocore ClientError
            if self._missing(e):
                return None
            raise

    def get_range(self, key: str, start: int, end: int) -> bytes | None:
        try:
            return self._client.get_object(Bucket=self._bucket, Key=key, Range=f"bytes={start}-{end}")["Body"].read()
        except Exception as e:
            if self._missing(e):
                return None
            if getattr(e, "response", {}).get("Error", {}).get("Code") == "InvalidRange":
                return b""
            raise

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token: str | None = None
        while True:
            kw: dict[str, Any] = {"Bucket": self._bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            res = self._client.list_objects_v2(**kw)
            keys.extend(o["Key"] for o in res.get("Contents", []) if o.get("Key"))
            token = res.get("NextContinuationToken")
            if not res.get("IsTruncated") or not token:
                break
        return sorted(keys)


class _LocalBackend:
    kind = "local"

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    def _path(self, key: str) -> Path:
        p = (self._root / key).resolve()
        if self._root not in p.parents:
            raise StorageKeyError()
        return p

    def put(self, key: str, body: bytes, content_type: str | None) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(body)

    def get(self, key: str) -> bytes | None:
        p = self._path(key)
        return p.read_bytes() if p.is_file() else None

    def get_range(self, key: str, start: int, end: int) -> bytes | None:
        data = self.get(key)
        return None if data is None else data[start : end + 1]

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def list(self, prefix: str) -> list[str]:
        base = self._root / prefix.rstrip("/")
        if not base.is_dir():
            return []
        return sorted(str(p.relative_to(self._root)) for p in base.rglob("*") if p.is_file())


class Storage:
    """비동기 저장소 API(TS putObject·getObject·getObjectRange·deleteObject·listByPrefix·putJson·getJson)."""

    def __init__(self, *, production: bool, env: dict[str, str] | None = None) -> None:
        cfg = r2_config(env)
        if cfg is None and production:
            self._backend: _R2Backend | _LocalBackend | None = None
        elif cfg is not None:
            self._backend = _R2Backend(cfg)
        else:
            e = os.environ if env is None else env
            self._backend = _LocalBackend(Path((e.get("STORAGE_DIR") or "").strip() or "data/storage"))

    @property
    def kind(self) -> str:
        return self._b().kind

    def _b(self) -> _R2Backend | _LocalBackend:
        if self._backend is None:
            raise StorageConfigError()
        return self._backend

    async def put_object(self, key: str, body: bytes | str, content_type: str | None = None) -> None:
        assert_valid_key(key)
        # 외톨이 서로게이트는 U+FFFD로(그대로면 UTF-8 인코딩이 실패한다 — Node Buffer.from과 같은 결과).
        data = well_formed(body).encode("utf-8") if isinstance(body, str) else body
        await asyncio.to_thread(self._b().put, key, data, content_type)

    async def get_object(self, key: str) -> bytes | None:
        assert_valid_key(key)
        return await asyncio.to_thread(self._b().get, key)

    async def get_object_range(self, key: str, start: int, end: int) -> bytes | None:
        assert_valid_key(key)
        if start < 0 or end < start:
            raise ValueError("잘못된 바이트 범위입니다.")
        return await asyncio.to_thread(self._b().get_range, key, start, end)

    async def delete_object(self, key: str) -> None:
        assert_valid_key(key)
        await asyncio.to_thread(self._b().delete, key)

    async def list_by_prefix(self, prefix: str) -> list[str]:
        assert_valid_key(prefix, prefix=True)
        return await asyncio.to_thread(self._b().list, prefix)

    async def put_json(self, key: str, value: Any) -> None:
        # JSON.stringify와 같은 바이트(공백 없음, 한글 그대로).
        # 외톨이 서로게이트(TS가 쓴 JSON의 \\udXXX 이스케이프를 읽은 값 포함)는 U+FFFD로 — 그대로면 UTF-8 인코딩이 실패한다.
        await self.put_object(key, json.dumps(well_formed_deep(value), ensure_ascii=False, separators=(",", ":")), "application/json; charset=utf-8")

    async def get_json(self, key: str) -> Any | None:
        data = await self.get_object(key)
        return None if data is None else json.loads(data.decode("utf-8"))
