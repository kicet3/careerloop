"""'resume-draft' 작업 테스트 공용: 실제 Postgres 준비(WORKER_TEST_DATABASE_URL이 있을 때만), 가짜 LLM 출력, 행 만들기."""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.jobs.resume_draft_output import empty_resume_document
from app.llm.types import LlmRequest

MIGRATIONS = Path(__file__).resolve().parents[2] / "prisma" / "migrations"


def real_database_url() -> str | None:
    """WORKER_TEST_DATABASE_URL: CREATE DATABASE 권한이 있는 로컬 주소. 없으면 실제 DB 테스트를 건너뛴다."""
    return (os.environ.get("WORKER_TEST_DATABASE_URL") or "").strip() or None


def create_test_database(admin_url: str) -> tuple[str, Callable[[], None]]:
    """새 DB를 만들고 prisma/migrations를 순서대로 적용한다. (그 DB 주소, 지우는 함수)."""
    import psycopg

    name = f"wt_resume_draft_{secrets.token_hex(4)}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')  # type: ignore[arg-type]
    p = urlsplit(admin_url)
    url = urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, ""))
    with psycopg.connect(url, autocommit=True) as conn:
        for d in sorted(x for x in MIGRATIONS.iterdir() if x.is_dir()):
            conn.execute((d / "migration.sql").read_text("utf-8"))  # type: ignore[arg-type]

    def drop() -> None:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')  # type: ignore[arg-type]

    return url, drop


def draft_output(**basics: str) -> dict[str, Any]:
    """스키마에 맞는 LLM 출력(지원 동기 없음). 수상·기타에 사소한 일화 한 줄을 넣어 정리 규칙이 도는지 본다."""
    doc = empty_resume_document()
    del doc["motivation"]
    doc["basics"].update({"name": "", "headline": "백엔드 개발자", "email": "[ADD: 이메일]", **basics})
    doc["summary"] = "결제 API를 만든 개발자입니다."
    doc["experience"] = [{"company": "페이랩", "department": "", "title": "개발자", "startDate": "2021.03", "endDate": "현재", "location": "", "scope": "", "bullets": ["응답 시간 40% 단축"]}]
    doc["extras"] = [{"title": "기타", "items": ["사내 툴을 1일 만에 만듦", "2022.05 해커톤 – 대상"]}]
    return {"document": doc, "notes": ["JD 대응: 충족 1개 / 확인 필요 0개"], "missingInfo": ["Kafka 경험이 있는지"]}


def draft_handler(req: LlmRequest) -> dict[str, Any]:
    return draft_output()


def job_input(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "kind": "company",
        "company": "페이랩",
        "roleTitle": "백엔드",
        "jdText": "Kotlin 경험자",
        "templateId": "developer",
        "title": "",
        "source": {"kind": "diagnosis", "diagnosisId": "d1"},
        "provider": "anthropic",
    }
    base.update(over)
    return base


def now() -> datetime:
    return datetime.now(UTC)


def jdump(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)
