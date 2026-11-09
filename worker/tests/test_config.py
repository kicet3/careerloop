from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import Settings, is_job_enabled, parse_worker_jobs
from app.db import libpq_conninfo
from tests.conftest import load_fixture


def test_refuses_short_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_SHARED_SECRET", "x" * 31)
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]
    monkeypatch.setenv("WORKER_SHARED_SECRET", "   " + "x" * 20 + "   ")
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_refuses_missing_secret() -> None:
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]


def test_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_SHARED_SECRET", "s" * 64)
    monkeypatch.setenv("WORKER_CONCURRENCY", "2")
    monkeypatch.setenv("APP_ENV", "PRODUCTION")
    monkeypatch.setenv("ANTHROPIC_MODEL", "  ")
    s = Settings()  # type: ignore[call-arg]
    assert s.secret == "s" * 64
    assert s.worker_concurrency == 2
    assert s.is_production
    assert s.anthropic_model is None
    assert "s" * 64 not in repr(s)


def test_create_app_refuses_short_secret() -> None:
    from app.main import create_app

    with pytest.raises(ValidationError):
        create_app(Settings(worker_shared_secret="short"))  # type: ignore[arg-type]


def test_worker_jobs_match_typescript() -> None:
    for c in load_fixture("worker_jobs.json"):
        jobs = parse_worker_jobs(c["raw"])
        assert jobs == c["jobs"]
        for kind, on in c["enabled"].items():
            assert is_job_enabled(jobs, kind) is on, (c["raw"], kind)


def test_conninfo_strips_prisma_params_and_forces_tls() -> None:
    url, schema = libpq_conninfo("postgresql://u:p@db.supabase.co:5432/postgres?pgbouncer=true&connection_limit=1&schema=app")
    assert schema == "app"
    assert "pgbouncer" not in url and "connection_limit" not in url and "schema=" not in url
    assert url.endswith("sslmode=require")
    assert libpq_conninfo("postgresql://u:p@127.0.0.1:5432/db")[0] == "postgresql://u:p@127.0.0.1:5432/db"
    assert libpq_conninfo("postgres://u:p@h/db?sslmode=verify-full")[0].endswith("sslmode=verify-full")
    assert libpq_conninfo("postgres://u:p@h/db?sslmode=prefer")[0].endswith("sslmode=require")
    with pytest.raises(ValueError):
        libpq_conninfo("file:./dev.db")
