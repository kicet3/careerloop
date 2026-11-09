"""면접 작업 실행부 — DB 대역(FakeDb + 저장 함수 바꿔치기)으로 항상 도는 테스트. SQL까지 보는 테스트는 test_interview_jobs_pg.py(실제 Postgres)."""

from __future__ import annotations

from typing import Any

import pytest

from app.jobs import interview_feedback, interview_questions
from app.jobs import interview_store as store
from app.jobs.registry import build_registry
from app.llm.types import LlmPermanentError
from tests.fake_llm import FakeLlmClient
from tests.fakes import FakeDb, make_context
from tests.interview_support import RecordingFactory, feedback_handler, make_snapshot, questions_handler


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def fn(self, name: str, result: Any) -> Any:
        async def f(*args: Any, **kwargs: Any) -> Any:
            self.calls.append((name, args[1:], kwargs))  # ctx 제외
            return result(*args, **kwargs) if callable(result) else result

        return f

    def names(self) -> list[str]:
        return [c[0] for c in self.calls]


def job_db(row: dict[str, Any] | None) -> FakeDb:
    return FakeDb(lambda sql, params: [row] if row is not None and "FROM interview_" in sql else [])


@pytest.fixture
def rec(monkeypatch: pytest.MonkeyPatch) -> Recorder:
    r = Recorder()
    monkeypatch.setattr(store, "load_source_snapshot", r.fn("load_source_snapshot", lambda *a, **k: make_snapshot()))
    monkeypatch.setattr(store, "complete_generation", r.fn("complete_generation", True))
    monkeypatch.setattr(store, "fail_generation", r.fn("fail_generation", True))
    monkeypatch.setattr(store, "session_title", r.fn("session_title", "토스 면접 연습"))
    monkeypatch.setattr(store, "get_question", r.fn("get_question", {"id": "q1", "category": "line", "facet": "measure", "question": "처리 시간은?", "intent": "측정", "citations": [{"ref": "r3", "quote": "처리 시간"}], "followUps": []}))
    monkeypatch.setattr(store, "complete_answer", r.fn("complete_answer", True))
    monkeypatch.setattr(store, "fail_answer", r.fn("fail_answer", True))
    # 시작 선점(조건부 UPDATE)은 SQL까지 test_interview_jobs_pg.py가 본다. 여기서는 이긴 것으로 둔다(기록하지 않는다).
    claims: list[tuple[str, ...]] = []

    async def claim_gen(ctx: Any, user_id: str, session_id: str, run_id: str, runner: str = "worker") -> bool:
        claims.append(("generation", user_id, session_id, run_id, runner))
        return r.claim_result  # type: ignore[attr-defined]

    async def claim_ans(ctx: Any, user_id: str, answer_id: str, runner: str = "worker") -> bool:
        claims.append(("answer", user_id, answer_id, runner))
        return r.claim_result  # type: ignore[attr-defined]

    r.claim_result = True  # type: ignore[attr-defined]
    r.claims = claims  # type: ignore[attr-defined]
    monkeypatch.setattr(store, "claim_generation_run", claim_gen)
    monkeypatch.setattr(store, "claim_answer_run", claim_ans)
    notified: list[Any] = []

    async def fake_notify(db: Any, user_id: str, n: Any) -> None:
        notified.append((user_id, n))

    monkeypatch.setattr(interview_questions, "notify", fake_notify)
    r.notified = notified  # type: ignore[attr-defined]
    return r


def test_registered() -> None:
    reg = build_registry()
    assert reg["interview-questions"] is interview_questions.KIND
    assert reg["interview-feedback"] is interview_feedback.KIND
    assert interview_questions.KIND.sweep_query is None and interview_feedback.KIND.sweep_query is None


async def test_questions_guard_no_row_no_llm(rec: Recorder) -> None:
    factory = RecordingFactory()
    ctx = make_context(job_db(None))
    ctx.llm = factory  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    assert factory.created == [] and rec.calls == []


async def test_questions_claim_lost_no_llm(rec: Recorder) -> None:
    """Vercel after()가 먼저 선점했으면 LLM을 부르지 않고 아무것도 쓰지 않는다."""
    rec.claim_result = False  # type: ignore[attr-defined]
    factory = RecordingFactory()
    ctx = make_context(job_db({"id": "s1", "user_id": "u-db", "provider": "anthropic"}))
    ctx.llm = factory  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    assert factory.created == [] and rec.calls == []
    assert rec.claims == [("generation", "u-db", "s1", "run1", "worker")]  # type: ignore[attr-defined]


async def test_feedback_claim_lost_no_llm(rec: Recorder) -> None:
    rec.claim_result = False  # type: ignore[attr-defined]
    factory = RecordingFactory()
    ctx = make_context(job_db(ANSWER_ROW))
    ctx.llm = factory  # type: ignore[assignment]
    await interview_feedback.run(ctx, "a1", "a1")
    assert factory.created == [] and rec.calls == []
    assert rec.claims == [("answer", ANSWER_ROW["user_id"], "a1", "worker")]  # type: ignore[attr-defined]


async def test_questions_success_uses_db_user(rec: Recorder) -> None:
    factory = RecordingFactory()
    db = job_db({"id": "s1", "user_id": "u-db", "provider": "anthropic"})
    ctx = make_context(db)
    ctx.llm = factory  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    assert rec.names() == ["load_source_snapshot", "complete_generation", "session_title"]
    assert rec.calls[0][1] == ("u-db", "s1")
    _, args, kwargs = rec.calls[1]
    assert args[0:2] == ("s1", "run1") and len(args[2]) == 4 and kwargs["model"] == "fake"
    assert factory.created[0][1].user_id == "u-db"
    # SQL 조건: id·run_id·status='generating'
    sql, params = db.calls[0]
    assert "run_id = %(run_id)s" in sql and "status = 'generating'" in sql and params == {"id": "s1", "run_id": "run1"}
    assert rec.notified[0][0] == "u-db" and rec.notified[0][1].kind == "interview-ready"  # type: ignore[attr-defined]


async def test_questions_llm_failure_message(rec: Recorder) -> None:
    client = FakeLlmClient({"interview-questions": questions_handler}, errors={"interview-questions": LlmPermanentError("거절", "refusal")})
    ctx = make_context(job_db({"id": "s1", "user_id": "u", "provider": "anthropic"}))
    ctx.llm = RecordingFactory(client)  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    name, args, _ = next(c for c in rec.calls if c[0] == "fail_generation")
    assert args == ("s1", "run1", "질문을 만들지 못했습니다. AI 모델이 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요.")
    assert "complete_generation" not in rec.names()


async def test_questions_save_retried_once(rec: Recorder, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.jobs import interview_common

    monkeypatch.setattr(interview_common, "SAVE_RETRY_DELAY_SEC", 0)
    attempts: list[int] = []

    async def flaky(*a: Any, **k: Any) -> bool:
        attempts.append(1)
        if len(attempts) == 1:
            raise ConnectionError("pool")
        return True

    monkeypatch.setattr(store, "complete_generation", flaky)
    ctx = make_context(job_db({"id": "s1", "user_id": "u", "provider": "anthropic"}))
    ctx.llm = RecordingFactory()  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    assert len(attempts) == 2 and "fail_generation" not in rec.names()


async def test_questions_skips_non_anthropic(rec: Recorder) -> None:
    factory = RecordingFactory()
    ctx = make_context(job_db({"id": "s1", "user_id": "u", "provider": "codex-cli"}))
    ctx.llm = factory  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    assert factory.created == [] and rec.calls == []


ANSWER_ROW = {"id": "a1", "user_id": "u-db", "session_id": "s1", "question_id": "q1", "answer": "제가 직접 쟀습니다.", "duration_sec": None, "status": "pending", "provider": "anthropic"}


async def test_feedback_guard(rec: Recorder) -> None:
    for row, run_id in [(None, "a1"), ({**ANSWER_ROW, "status": "done"}, "a1"), (ANSWER_ROW, "not-the-id")]:
        factory = RecordingFactory()
        ctx = make_context(job_db(row))
        ctx.llm = factory  # type: ignore[assignment]
        assert await interview_feedback.precheck(ctx, "a1", run_id) is None
        await interview_feedback.run(ctx, "a1", run_id)
        assert factory.created == []
    assert rec.calls == []


async def test_feedback_success_and_failure(rec: Recorder) -> None:
    factory = RecordingFactory(FakeLlmClient({"interview-feedback": feedback_handler}))
    ctx = make_context(job_db(ANSWER_ROW))
    ctx.llm = factory  # type: ignore[assignment]
    await interview_feedback.run(ctx, "a1", "a1")
    assert rec.names() == ["get_question", "load_source_snapshot", "complete_answer"]
    assert rec.calls[0][1] == ("u-db", "s1", "q1")
    _, args, kwargs = rec.calls[2]
    assert args[0] == "a1" and args[1]["overall"] == 72 and kwargs["provider"] == "anthropic"
    assert factory.created[0][1].user_id == "u-db" and factory.created[0][1].reference_id == "s1"

    rec.calls.clear()
    client = FakeLlmClient({}, errors={"interview-feedback": LlmPermanentError("x", "max_tokens")})
    ctx.llm = RecordingFactory(client)  # type: ignore[assignment]
    await interview_feedback.run(ctx, "a1", "a1")
    name, args, _ = rec.calls[-1]
    assert name == "fail_answer"
    assert args == ("a1", "피드백을 만들지 못했습니다. AI 응답이 서버의 출력 길이 한도에서 끊겼습니다(한도를 올려 다시 요청한 뒤에도). 다시 시도해 주세요.")
