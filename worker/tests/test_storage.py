from __future__ import annotations

from pathlib import Path

import pytest

from app.storage import Storage, StorageConfigError, StorageKeyError, assert_user_key, assert_valid_key, r2_config, user_key, user_prefix


def test_key_rules_match_typescript() -> None:
    assert user_key("u1", "resumes", "r1.json") == "users/u1/resumes/r1.json"
    assert user_prefix("u1", "resumes") == "users/u1/resumes/"
    for bad in ["", "users/u1", "other/u1/x", "users/../x", "users/u1/../u2/x", "users/u1/.hidden", "users//x", "users/u1/a b"]:
        with pytest.raises(StorageKeyError):
            assert_valid_key(bad)
    assert_valid_key("users/-abc/x")  # nanoid는 '-'로 시작할 수 있다


def test_assert_user_key_blocks_other_users() -> None:
    assert assert_user_key("u1", "users/u1/a/b") == "users/u1/a/b"
    for key in ["users/u2/a/b", "users/u10/a/b", "shared-postings/u1/x"]:
        with pytest.raises(StorageKeyError):
            assert_user_key("u1", key)
    with pytest.raises(StorageKeyError):
        assert_user_key("", "users//a")


def test_r2_env_names() -> None:
    env = {"R2_ACCOUNT_ID": "acc", "R2_ACCESS_KEY_ID": "k", "R2_SECRET_ACCESS_KEY": "s", "R2_BUCKET": "b"}
    cfg = r2_config(env)
    assert cfg is not None and cfg.endpoint == "https://acc.r2.cloudflarestorage.com"
    assert r2_config({**env, "R2_ENDPOINT": "https://x"}).endpoint == "https://x"  # type: ignore[union-attr]
    assert r2_config({**env, "R2_BUCKET": ""}) is None


async def test_production_without_r2_refuses() -> None:
    s = Storage(production=True, env={})
    with pytest.raises(StorageConfigError):
        await s.get_object("users/u1/a")


async def test_local_backend_roundtrip(tmp_path: Path) -> None:
    s = Storage(production=False, env={"STORAGE_DIR": str(tmp_path)})
    await s.put_json("users/u1/x/a.json", {"한": 1})
    assert await s.get_json("users/u1/x/a.json") == {"한": 1}
    assert (tmp_path / "users/u1/x/a.json").read_bytes() == '{"한":1}'.encode()
    assert await s.get_object_range("users/u1/x/a.json", 0, 1) == b'{"'
    assert await s.list_by_prefix("users/u1/") == ["users/u1/x/a.json"]
    await s.delete_object("users/u1/x/a.json")
    assert await s.get_object("users/u1/x/a.json") is None
