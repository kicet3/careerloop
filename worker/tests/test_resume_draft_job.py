"""'resume-draft' 실행부의 SQL 조건(DB 가짜) — 실제 Postgres 없이도 도는 최소 확인. 전체 흐름은 test_resume_draft_job_pg.py."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.jobs.resume_draft import RunDeps, draft_error_message, run_resume_draft
from app.jobs.resume_draft_resumes import FeatureError
from app.llm.types import LlmPermanentError
from tests.fake_llm import FakeLlmClient
from tests.fakes import FakeDb, make_context
from tests.resume_draft_support import draft_handler, job_input

ROW = {
    "id": "j1",
    "user_id": "owner",
    "run_id": "r1",
    "status": "running",
    "stage": "material",
    "label": "페이랩 · 백엔드",
    "input": job_input(),
    "provider": "anthropic",
    "target_resume_id": None,
    "result": None,
    "started_at": datetime.now(UTC),
}


def _db(*, claim_rows: int) -> FakeDb:
    def handler(sql: str, params: Any) -> Any:
        if sql.startswith("SELECT id, user_id, run_id"):
            return [dict(ROW)]
        if sql.startswith("SELECT id, name, email FROM users"):
            return [{"id": params[0], "name": "홍길동", "email": "a@x.com"}]
        if sql.startswith("SELECT id, title FROM diagnoses"):
            return [{"id": "d1", "title": "진단"}]
        if sql.startswith("SELECT output FROM diagnosis_stages"):
            return [{"output": {"resumeMarkdown": "md", "changes": [], "addQuestions": [], "assumptions": []}}]
        if sql.startswith("UPDATE resume_draft_jobs SET stage"):
            return claim_rows
        if sql.startswith("UPDATE resume_draft_jobs SET status = 'failed'"):
            return 1
        return []

    return FakeDb(handler)


async def test_claim_lost_means_no_llm_and_no_writes() -> None:
    db = _db(claim_rows=0)
    llm = FakeLlmClient({"resume-draft": draft_handler})
    await run_resume_draft(make_context(db), "j1", "r1", RunDeps(create_client=lambda p, u: llm))
    assert llm.calls == []
    claim = [(s, p) for s, p in db.calls if s.startswith("UPDATE resume_draft_jobs SET stage")]
    assert len(claim) == 1 and "stage = 'material'" in claim[0][0] and "status = 'running'" in claim[0][0]
    # 신원은 작업 행에서 읽은 값(요청에는 user_id가 없다).
    assert claim[0][1]["user_id"] == "owner" and claim[0][1]["run_id"] == "r1"
    assert not any(s.startswith("UPDATE resume_draft_jobs SET status") for s, _ in db.calls)
    assert not any("INSERT INTO notifications" in s for s, _ in db.calls)


async def test_failure_after_claim_writes_failed_with_owner_condition() -> None:
    db = _db(claim_rows=1)
    llm = FakeLlmClient(errors={"resume-draft": LlmPermanentError("x", "max_tokens")})
    await run_resume_draft(make_context(db), "j1", "r1", RunDeps(create_client=lambda p, u: llm))
    failed = [(s, p) for s, p in db.calls if s.startswith("UPDATE resume_draft_jobs SET status = 'failed'")]
    assert len(failed) == 1
    sql, params = failed[0]
    assert "stage = 'material'" not in sql and "user_id = %(user_id)s" in sql
    assert params["error"] == "초안을 만들지 못했습니다. AI 응답이 서버의 출력 길이 한도에서 끊겼습니다(한도를 올려 다시 요청한 뒤에도). 다시 시도해 주세요."


def test_error_messages_match_ts() -> None:
    assert draft_error_message(FeatureError("진단을 찾을 수 없습니다.", 404)) == "진단을 찾을 수 없습니다."
    assert draft_error_message(LlmPermanentError("x", "invalid_output")) == "초안을 만들지 못했습니다. AI 응답이 정해진 형식과 맞지 않았습니다(재요청 후에도 실패). 다시 시도해 주세요."
    assert draft_error_message(LlmPermanentError("x", "unavailable")) == "초안을 만들지 못했습니다. 선택한 AI 엔진을 지금 쓸 수 없습니다(CLI 미설치 또는 기능 꺼짐). 'AI 연결' 화면을 확인해 주세요."
    assert draft_error_message(TimeoutError()) == "초안을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요."
    assert draft_error_message(RuntimeError("secret body")) == "초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
