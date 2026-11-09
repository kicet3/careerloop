"""면접 작업 테스트 공용: 가짜 LLM 처리기·팩토리, 스냅숏 만들기, 실제 Postgres 준비(WORKER_TEST_DATABASE_URL이 있을 때만)."""

from __future__ import annotations

import os
import re
import secrets
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.llm.types import LlmClient, LlmRequest
from app.llm.usage import LlmUsageContext
from tests.fake_llm import FakeLlmClient

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO_ROOT / "prisma" / "migrations"

_SOURCE_RE = re.compile(r"<interview_sources>\n(.*?)\n</interview_sources>", re.S)
_LINE_RE = re.compile(r"^\[([rpj]\d+)\] \([^)]*\) (.*)$")


def source_lines_in(user: str) -> list[tuple[str, str]]:
    m = _SOURCE_RE.search(user)
    if not m:
        return []
    out = []
    for line in m.group(1).split("\n"):
        mm = _LINE_RE.match(line)
        if mm:
            out.append((mm.group(1), mm.group(2)))
    return out


def questions_handler(req: LlmRequest) -> dict[str, Any]:
    """근거 줄을 글자 그대로 인용한 질문(이력서 줄마다 line 1개) + 자기소개."""
    qs = []
    for i, (ref, text) in enumerate(l for l in source_lines_in(req.user) if l[0].startswith("r")):
        qs.append({"category": "line", "facet": "why", "question": f"{text[:30]}는 왜 필요했나요? ({i + 1})", "intent": "필요성", "citations": [{"ref": ref, "quote": text[:20]}], "followUps": ["누가 정했나요?"]})
    qs.append({"category": "motivation", "facet": "intro", "question": "자기소개 해 주세요.", "intent": "", "citations": [], "followUps": []})
    return {"questions": qs[:40], "notes": []}


def no_evidence_handler(req: LlmRequest) -> dict[str, Any]:
    return {"questions": [{"category": "line", "facet": "why", "question": "지어낸 질문", "intent": "", "citations": [{"ref": "r1", "quote": "서류에 없는 문장"}], "followUps": []}], "notes": []}


def feedback_handler(req: LlmRequest) -> dict[str, Any]:
    lines = source_lines_in(req.user)
    ref = lines[0][0] if lines else None
    c = lambda s: {"score": s, "comment": "평가"}  # noqa: E731
    return {
        "overall": 72,
        "criteria": {"evidence": c(4), "numbers": c(4), "ownership": c(3), "length": c(3), "structure": c(4)},
        "strengths": ["근거를 먼저 냈습니다."],
        "improvements": ["측정 기간을 더하세요."],
        "unsupportedClaims": [],
        "modelAnswer": {"conclusion": "결론입니다.", "points": [{"text": "근거", "ref": ref}], "limitation": ""},
        "followUp": "\"측정은 누가 했나요?\"",
    }


class RecordingFactory:
    """ctx.llm 대신. create()에 넘어온 provider·사용량 문맥(user_id)을 기록한다."""

    model = "fake"

    def __init__(self, client: LlmClient | None = None) -> None:
        self.client = client or FakeLlmClient({"interview-questions": questions_handler, "interview-feedback": feedback_handler})
        self.created: list[tuple[object, LlmUsageContext]] = []

    def create(self, provider: object, ctx: LlmUsageContext) -> LlmClient:
        from app.llm.types import assert_worker_provider

        assert_worker_provider(provider)
        self.created.append((provider, ctx))
        return self.client

    def model_name(self) -> str:
        return self.model

    async def close(self) -> None: ...


def make_snapshot(lines: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    lines = lines or [
        {"id": "r1", "doc": "resume", "label": "지원 직무", "path": "basics.headline", "text": "결제 백엔드 개발자"},
        {"id": "r2", "doc": "resume", "label": "경력 · 토스 백엔드 · 담당 범위", "path": "experience.0.scope", "text": "정산 시스템 설계와 운영"},
        {"id": "r3", "doc": "resume", "label": "경력 · 토스 백엔드 · 기여 1", "path": "experience.0.bullets.0", "text": "정산 배치를 재작성해 처리 시간을 50분에서 35분으로 줄임"},
        {"id": "j1", "doc": "posting", "label": "채용 공고 1", "path": None, "text": "주요 업무: 결제 정산 시스템 개발과 운영"},
    ]
    return {
        "version": 1,
        "resume": {"id": "res1", "title": "토스 백엔드", "kind": "company", "company": "토스", "roleTitle": "백엔드", "versionId": "v1", "versionNo": 1},
        "posting": {"id": "jp1", "company": "토스", "roleTitle": "백엔드", "url": "https://toss.im/career/1"},
        "portfolio": None,
        "lines": lines,
        "createdAt": 0,
    }


# ---------------------------------------------------------------------------
# 실제 Postgres (선택)
# ---------------------------------------------------------------------------


def real_database_url() -> str | None:
    """WORKER_TEST_DATABASE_URL: CREATE DATABASE 권한이 있는 관리용 주소(로컬 임시 컨테이너). 없으면 실제 DB 테스트를 건너뛴다."""
    return (os.environ.get("WORKER_TEST_DATABASE_URL") or "").strip() or None


def create_test_database(admin_url: str) -> tuple[str, Callable[[], None]]:
    """새 DB를 만들고 prisma/migrations를 순서대로 적용한다. (그 DB 주소, 지우는 함수)."""
    import psycopg

    name = f"wt_interview_{secrets.token_hex(4)}"
    with psycopg.connect(admin_url, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    p = urlsplit(admin_url)
    url = urlunsplit((p.scheme, p.netloc, f"/{name}", p.query, ""))
    with psycopg.connect(url, autocommit=True) as conn:
        for d in sorted(x for x in MIGRATIONS.iterdir() if x.is_dir()):
            conn.execute((d / "migration.sql").read_text("utf-8"))  # type: ignore[arg-type]

    def drop() -> None:
        with psycopg.connect(admin_url, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')

    return url, drop
