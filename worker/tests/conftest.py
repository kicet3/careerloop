from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text("utf-8"))


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # 개발자 셸의 실제 비밀값·주소가 테스트에 섞이지 않게 한다.
    for k in [
        "WORKER_SHARED_SECRET",
        "DATABASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
        "NEO4J_URI",
        "NEO4J_PASSWORD",
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET",
        "R2_ENDPOINT",
        "APP_ENV",
        "WORKER_JOBS",
        "WORKER_CONCURRENCY",
        "STORAGE_DIR",
    ]:
        monkeypatch.delenv(k, raising=False)
