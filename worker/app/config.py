"""워커 설정(pydantic-settings). 이름은 Vercel 쪽 환경 변수와 같다(docs/PYTHON-WORKER.md §6).

- WORKER_SHARED_SECRET이 32자 미만이면 설정 객체를 만들 수 없다 → 워커가 시작하지 않는다.
- 비밀값은 repr·로그에 나오지 않게 SecretStr로 둔다.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_SECRET_LENGTH = 32


def parse_worker_jobs(raw: str | None) -> list[str]:
    """쉼표 목록 → 정리된 항목(소문자·공백 제거·빈 항목 제거). TS src/lib/worker/config.ts parseWorkerJobs와 같다."""
    return [s.strip().lower() for s in (raw or "").split(",") if s.strip()]


def is_job_enabled(jobs: list[str] | tuple[str, ...], kind: str) -> bool:
    """'*'는 전부, 'interview'는 'interview-…' 전부. TS isJobEnabled와 같다."""
    return any(j == "*" or j == kind or kind.startswith(f"{j}-") for j in jobs)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False, env_ignore_empty=True)

    worker_shared_secret: SecretStr
    database_url: SecretStr | None = None

    anthropic_api_key: SecretStr | None = None
    anthropic_model: str | None = None

    neo4j_uri: str | None = None
    neo4j_user: str | None = None
    neo4j_password: SecretStr | None = None
    neo4j_database: str | None = None

    r2_account_id: str | None = None
    r2_access_key_id: SecretStr | None = None
    r2_secret_access_key: SecretStr | None = None
    r2_bucket: str | None = None
    r2_endpoint: str | None = None

    app_env: str | None = None

    worker_concurrency: int = Field(default=4, ge=1, le=32)
    #: 이 워커가 받는·스위퍼가 다시 집는 작업 종류(쉼표 목록, 기본 '*'). Vercel의 WORKER_JOBS와 같은 형식.
    worker_jobs: str = "*"
    #: 동시 실행 수(WORKER_CONCURRENCY)를 넘겨 대기열에 받아 둘 작업 수(기본 0 — 빈 자리가 없으면 503, Vercel이 직접 실행한다).
    #: 시간 상한은 작업 행의 시작 시각부터 재므로 대기 시간도 상한을 깎는다. 짧은 상한 작업(포트폴리오 270초, 면접 5~6분 stale)이 있어 작게 둔다.
    worker_queue_backlog: int = Field(default=0, ge=0, le=64)
    worker_sweep_interval_sec: float = Field(default=60.0, gt=0)
    #: 'queued'인 채 이 시간(초)이 지나도록 아무도 집지 않은 작업을 스위퍼가 다시 집는다.
    worker_sweep_after_sec: int = Field(default=120, ge=10)

    @field_validator("worker_shared_secret")
    @classmethod
    def _secret_long_enough(cls, v: SecretStr) -> SecretStr:
        raw = v.get_secret_value().strip()
        if len(raw) < MIN_SECRET_LENGTH:
            raise ValueError(f"WORKER_SHARED_SECRET은 {MIN_SECRET_LENGTH}자 이상이어야 합니다(openssl rand -hex 32).")
        return SecretStr(raw)

    @field_validator("anthropic_model", "neo4j_uri", "neo4j_user", "neo4j_database", "r2_account_id", "r2_bucket", "r2_endpoint", "app_env", mode="before")
    @classmethod
    def _blank_to_none(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @property
    def secret(self) -> str:
        return self.worker_shared_secret.get_secret_value()

    @property
    def is_production(self) -> bool:
        return (self.app_env or "").upper() == "PRODUCTION"

    @property
    def enabled_jobs(self) -> list[str]:
        return parse_worker_jobs(self.worker_jobs)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
