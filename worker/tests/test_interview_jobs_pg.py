"""면접 작업(interview-questions·interview-feedback)을 실제 Postgres(prisma/migrations 적용)에서 실행한다.

WORKER_TEST_DATABASE_URL(CREATE DATABASE 권한이 있는 임시 DB 주소)이 없으면 건너뛴다. 예:
  docker run -d --rm --name wt-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17-alpine
  WORKER_TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55433/postgres uv run pytest -q tests/test_interview_jobs_pg.py
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest

from app.db import Database
from app.jobs import interview_feedback, interview_questions
from app.jobs.base import WorkerContext
from app.jobs.queue import JobQueue
from app.llm.types import GenerateResult, LlmPermanentError, LlmRequest
from app.storage import Storage
from tests.fake_llm import FakeLlmClient
from tests.fakes import FakeGraph, make_settings
from tests.interview_support import (
    RecordingFactory,
    create_test_database,
    feedback_handler,
    make_snapshot,
    no_evidence_handler,
    questions_handler,
    real_database_url,
)

ADMIN_URL = real_database_url()
pytestmark = pytest.mark.skipif(ADMIN_URL is None, reason="WORKER_TEST_DATABASE_URL 없음(실제 Postgres 테스트 건너뜀)")

UA, UB = "ua", "ub"


@pytest.fixture(scope="module")
def db_url() -> Iterator[str]:
    assert ADMIN_URL
    url, drop = create_test_database(ADMIN_URL)
    try:
        yield url
    finally:
        drop()


@pytest.fixture
async def db(db_url: str) -> AsyncIterator[Database]:
    d = Database(db_url, min_size=1, max_size=4)
    await d.open()
    await d.execute(
        "TRUNCATE interview_answers, interview_questions, interview_sessions, notifications, users CASCADE"
    )
    for uid in (UA, UB):
        await d.execute("INSERT INTO users (id, email) VALUES (%(id)s, %(email)s)", {"id": uid, "email": f"{uid}@x.com"})
    try:
        yield d
    finally:
        await d.close()


@pytest.fixture
def storage(tmp_path: Path) -> Storage:
    return Storage(production=False, env={"STORAGE_DIR": str(tmp_path)})


def make_ctx(db: Database, storage: Storage, factory: RecordingFactory | None = None) -> WorkerContext:
    return WorkerContext(settings=make_settings(), db=db, llm=factory or RecordingFactory(), graph=FakeGraph(), storage=storage)  # type: ignore[arg-type]


async def seed_session(
    db: Database,
    storage: Storage,
    *,
    sid: str = "s1",
    user: str = UA,
    run_id: str = "run1",
    status: str = "generating",
    provider: str | None = "anthropic",
    snapshot: dict[str, Any] | None = None,
    source_key: str | None = "default",
) -> None:
    key = f"users/{user}/interview/{sid}/source.json" if source_key == "default" else source_key
    if snapshot is not None or source_key == "default":
        assert key is not None
        await storage.put_json(key, snapshot or make_snapshot())
    await db.execute(
        "INSERT INTO interview_sessions (id, user_id, title, resume_label, status, run_id, provider, model, source_key, usage) "
        "VALUES (%(id)s, %(u)s, %(t)s, 'l', %(st)s, %(run)s, %(p)s, 'claude-x', %(k)s, '{\"inputTokens\":1,\"outputTokens\":2,\"cacheReadTokens\":3,\"cacheWriteTokens\":4}'::jsonb)",
        {"id": sid, "u": user, "t": f"{sid} 면접 연습", "st": status, "run": run_id, "p": provider, "k": key},
    )


async def session(db: Database, sid: str = "s1") -> dict[str, Any]:
    row = await db.fetchone("SELECT * FROM interview_sessions WHERE id = %(id)s", {"id": sid})
    assert row is not None
    return row


async def notifications(db: Database, user: str = UA) -> list[dict[str, Any]]:
    return await db.fetchall("SELECT kind, title, body, link FROM notifications WHERE user_id = %(u)s ORDER BY created_at", {"u": user})


# ---------------------------------------------------------------------------
# interview-questions
# ---------------------------------------------------------------------------


async def test_questions_success_writes_result_and_notifies(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    factory = RecordingFactory()
    ctx = make_ctx(db, storage, factory)
    assert await interview_questions.KIND.precheck(ctx, "s1", "run1") is not None
    await interview_questions.run(ctx, "s1", "run1")

    s = await session(db)
    assert s["status"] == "ready" and s["error"] is None and s["generated_at"] is not None
    assert s["model"] == "fake"
    qs = await db.fetchall("SELECT ord, category, facet, question, citations, follow_ups FROM interview_questions WHERE session_id = 's1' ORDER BY ord")
    assert s["question_count"] == len(qs) == 4  # 이력서 3줄 + 자기소개
    assert [q["ord"] for q in qs] == [0, 1, 2, 3]
    assert qs[0]["citations"][0]["verified"] is True and qs[0]["follow_ups"] == ["누가 정했나요?"]
    # 사용량: 기존 값 + 가짜 LLM(출력 800)
    assert s["usage"]["outputTokens"] == 802 and s["usage"]["cacheWriteTokens"] == 4
    # 사용량 문맥의 user_id는 DB 행 값
    assert factory.created[0][1].user_id == UA and factory.created[0][1].reference_id == "s1"
    req: LlmRequest = factory.client.calls[0]  # type: ignore[attr-defined]
    assert (req.task, req.effort, req.max_tokens, req.cache_user) == ("interview-questions", "medium", 32_000, False)
    assert await notifications(db) == [{"kind": "interview-ready", "title": "면접 예상 질문이 준비됐습니다", "body": "s1 면접 연습 — 질문 4개", "link": "/app/interview/s1"}]


async def test_questions_guard_wrong_run_or_finished_does_nothing(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    await seed_session(db, storage, sid="s2", status="ready")
    factory = RecordingFactory()
    ctx = make_ctx(db, storage, factory)
    assert await interview_questions.KIND.precheck(ctx, "s1", "old-run") is None
    assert await interview_questions.KIND.precheck(ctx, "s2", "run1") is None
    await interview_questions.run(ctx, "s1", "old-run")
    await interview_questions.run(ctx, "s2", "run1")
    assert factory.created == []
    assert (await session(db))["status"] == "generating"
    assert (await session(db, "s2"))["status"] == "ready"
    assert await notifications(db) == []


class _OtherRunnerWins:
    """LLM을 기다리는 동안 다른 실행(Vercel after() 경로)이 같은 세션을 먼저 끝낸다."""

    name = "race"

    def __init__(self, db: Database) -> None:
        self.db = db
        self.inner = FakeLlmClient({"interview-questions": questions_handler})

    async def generate(self, req: LlmRequest) -> GenerateResult[Any]:
        await self.db.execute("UPDATE interview_sessions SET status = 'ready', question_count = 7 WHERE id = 's1'")
        return await self.inner.generate(req)


async def test_questions_guard_late_result_is_discarded(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    ctx = make_ctx(db, storage, RecordingFactory(_OtherRunnerWins(db)))  # type: ignore[arg-type]
    await interview_questions.run(ctx, "s1", "run1")
    s = await session(db)
    assert s["status"] == "ready" and s["question_count"] == 7 and s["model"] == "claude-x"
    assert await db.fetchall("SELECT id FROM interview_questions WHERE session_id = 's1'") == []
    assert await notifications(db) == []


async def test_questions_concurrent_runs_write_once(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    ctx = make_ctx(db, storage, RecordingFactory(FakeLlmClient({"interview-questions": questions_handler}, delay_sec=0.05)))
    await asyncio.gather(interview_questions.run(ctx, "s1", "run1"), interview_questions.run(ctx, "s1", "run1"))
    rows = await db.fetchall("SELECT ord FROM interview_questions WHERE session_id = 's1'")
    assert len(rows) == 4
    assert [n["kind"] for n in await notifications(db)] == ["interview-ready"]


async def test_questions_llm_failure_writes_failed_with_ts_message(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    client = FakeLlmClient({"interview-questions": questions_handler}, errors={"interview-questions": LlmPermanentError("거절", "refusal")})
    await interview_questions.run(make_ctx(db, storage, RecordingFactory(client)), "s1", "run1")
    s = await session(db)
    msg = "질문을 만들지 못했습니다. AI 모델이 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요."
    assert s["status"] == "failed" and s["error"] == msg
    assert await notifications(db) == [{"kind": "interview-failed", "title": "면접 예상 질문을 만들지 못했습니다", "body": f"s1 면접 연습 — {msg}", "link": "/app/interview/s1"}]


async def test_questions_unexpected_error_and_timeout(db: Database, storage: Storage, monkeypatch: pytest.MonkeyPatch) -> None:
    await seed_session(db, storage)
    client = FakeLlmClient({}, errors={"interview-questions": RuntimeError("boom")})
    await interview_questions.run(make_ctx(db, storage, RecordingFactory(client)), "s1", "run1")
    assert (await session(db))["error"] == "질문을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."

    await seed_session(db, storage, sid="s2")
    monkeypatch.setattr(interview_questions, "timeout_sec", 0.05)
    slow = FakeLlmClient({"interview-questions": questions_handler}, delay_sec=1.0)
    await interview_questions.run(make_ctx(db, storage, RecordingFactory(slow)), "s2", "run1")
    s2 = await session(db, "s2")
    assert s2["status"] == "failed" and s2["error"] == "질문을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 만들어 주세요."


async def test_questions_missing_snapshot_and_no_evidence(db: Database, storage: Storage) -> None:
    await seed_session(db, storage, source_key=None)
    await interview_questions.run(make_ctx(db, storage), "s1", "run1")
    s = await session(db)
    assert s["status"] == "failed" and s["error"] == "근거 자료를 찾지 못했습니다. 새 연습을 만들어 주세요."
    assert await notifications(db) == []  # TS도 이 경우는 알리지 않는다

    await seed_session(db, storage, sid="s2")
    client = FakeLlmClient({"interview-questions": no_evidence_handler})
    await interview_questions.run(make_ctx(db, storage, RecordingFactory(client)), "s2", "run1")
    s2 = await session(db, "s2")
    assert s2["status"] == "failed" and s2["error"] == "서류에서 근거를 확인할 수 있는 질문을 만들지 못했습니다. 다시 만들어 주세요."
    assert [n["kind"] for n in await notifications(db)] == ["interview-failed"]


async def test_questions_never_reads_other_users_snapshot(db: Database, storage: Storage) -> None:
    # ub의 스냅숏이 있고, ua 세션 행의 source_key가 (조작돼) ub 접두사를 가리킨다.
    other = make_snapshot()
    other["lines"][0]["text"] = "UB_SECRET_LINE"
    await storage.put_json("users/ub/interview/sx/source.json", other)
    await seed_session(db, storage, source_key="users/ub/interview/sx/source.json", snapshot=None)
    factory = RecordingFactory()
    await interview_questions.run(make_ctx(db, storage, factory), "s1", "run1")
    assert factory.created == []  # LLM에 넘기지 않는다
    assert (await session(db))["error"] == "근거 자료를 찾지 못했습니다. 새 연습을 만들어 주세요."


async def test_questions_provider_must_be_anthropic(db: Database, storage: Storage) -> None:
    await seed_session(db, storage, provider="claude-cli")
    factory = RecordingFactory()
    ctx = make_ctx(db, storage, factory)
    q = JobQueue(ctx, {"interview-questions": interview_questions.KIND}, concurrency=1, backlog=8)
    assert await q.accept("interview-questions", "s1", "run1") == "unsupported_provider"
    await interview_questions.run(ctx, "s1", "run1")  # 직접 불러도 쓰지 않는다(Vercel이 실행)
    assert factory.created == [] and (await session(db))["status"] == "generating"


async def test_questions_precheck_reads_user_from_db(db: Database, storage: Storage) -> None:
    await seed_session(db, storage, user=UB)
    ref = await interview_questions.KIND.precheck(make_ctx(db, storage), "s1", "run1")
    assert ref is not None and ref.user_id == UB and ref.provider == "anthropic"


# ---------------------------------------------------------------------------
# interview-feedback
# ---------------------------------------------------------------------------


async def seed_answer(db: Database, *, aid: str = "a1", user: str = UA, sid: str = "s1", qid: str = "q1", status: str = "pending") -> None:
    await db.execute(
        "INSERT INTO interview_answers (id, question_id, session_id, user_id, answer, duration_sec, status) VALUES (%(id)s, %(q)s, %(s)s, %(u)s, %(a)s, 30, %(st)s)",
        {"id": aid, "q": qid, "s": sid, "u": user, "a": "제가 직접 배치 로그로 쟀고 3개월 평균 50분에서 35분이 됐습니다.", "st": status},
    )


async def seed_question(db: Database, *, qid: str = "q1", sid: str = "s1", best: int | None = None) -> None:
    await db.execute(
        "INSERT INTO interview_questions (id, session_id, ord, category, facet, question, intent, citations, follow_ups, best_score) "
        "VALUES (%(id)s, %(s)s, %(ord)s, 'line', 'measure', '처리 시간은 어떻게 쟀나요?', '측정 방법', "
        "'[{\"ref\":\"r3\",\"doc\":\"resume\",\"quote\":\"처리 시간\",\"verified\":true}]'::jsonb, '[]'::jsonb, %(best)s)",
        {"id": qid, "s": sid, "ord": 0 if qid == "q1" else 1, "best": best},
    )


async def ready_session_with_question(db: Database, storage: Storage, *, user: str = UA, sid: str = "s1", qid: str = "q1") -> None:
    await seed_session(db, storage, sid=sid, user=user, status="ready")
    await seed_question(db, qid=qid, sid=sid)


async def test_feedback_success_updates_answer_question_session(db: Database, storage: Storage) -> None:
    await ready_session_with_question(db, storage)
    await seed_answer(db)
    factory = RecordingFactory()
    ctx = make_ctx(db, storage, factory)
    ref = await interview_feedback.KIND.precheck(ctx, "a1", "a1")
    assert ref is not None and ref.user_id == UA and ref.provider == "anthropic"
    await interview_feedback.run(ctx, "a1", "a1")

    a = await db.fetchone("SELECT * FROM interview_answers WHERE id = 'a1'")
    assert a is not None and a["status"] == "done" and a["error"] is None and a["completed_at"] is not None
    assert a["score"] == 72 and a["provider"] == "anthropic" and a["model"] == "fake" and a["usage"]["outputTokens"] == 800
    fb = a["feedback"]
    assert fb["followUp"] == "측정은 누가 했나요?"
    assert fb["modelAnswer"]["points"][0]["ref"] == "r2"  # 관련 줄: 인용 r3 + 같은 경력 항목 r2(문서 순서 첫 줄)
    assert fb["recommendedSeconds"] == {"min": 30, "max": 90} and fb["estimatedSeconds"] > 0
    q = await db.fetchone("SELECT attempt_count, best_score, status, last_answered_at FROM interview_questions WHERE id = 'q1'")
    assert q is not None and (q["attempt_count"], q["best_score"], q["status"]) == (1, 72, "practiced") and q["last_answered_at"] is not None
    s = await session(db)
    assert s["answered_count"] == 1 and s["usage"]["outputTokens"] == 802
    assert factory.created[0][1].user_id == UA and factory.created[0][1].reference_id == "s1"
    req: LlmRequest = factory.client.calls[0]  # type: ignore[attr-defined]
    assert (req.task, req.effort, req.max_tokens, req.cache_user) == ("interview-feedback", "low", 12_000, False)
    assert "- 지원자가 적은 답변 시간: 30초" in req.user


async def test_feedback_guard(db: Database, storage: Storage) -> None:
    await ready_session_with_question(db, storage)
    await seed_answer(db, status="done")
    await seed_answer(db, aid="a2")
    factory = RecordingFactory()
    ctx = make_ctx(db, storage, factory)
    assert await interview_feedback.KIND.precheck(ctx, "a1", "a1") is None  # 이미 끝남
    assert await interview_feedback.KIND.precheck(ctx, "a2", "other") is None  # runId는 답변 id여야 한다
    await interview_feedback.run(ctx, "a1", "a1")
    await interview_feedback.run(ctx, "a2", "other")
    assert factory.created == []
    a2 = await db.fetchone("SELECT status FROM interview_answers WHERE id = 'a2'")
    assert a2 == {"status": "pending"}


async def test_feedback_concurrent_runs_count_once(db: Database, storage: Storage) -> None:
    await ready_session_with_question(db, storage)
    await seed_answer(db)
    ctx = make_ctx(db, storage, RecordingFactory(FakeLlmClient({"interview-feedback": feedback_handler}, delay_sec=0.05)))
    await asyncio.gather(interview_feedback.run(ctx, "a1", "a1"), interview_feedback.run(ctx, "a1", "a1"))
    q = await db.fetchone("SELECT attempt_count FROM interview_questions WHERE id = 'q1'")
    assert q == {"attempt_count": 1}


async def test_feedback_llm_failure_writes_failed_with_ts_message(db: Database, storage: Storage) -> None:
    await ready_session_with_question(db, storage)
    await seed_answer(db)
    client = FakeLlmClient({}, errors={"interview-feedback": LlmPermanentError("x", "invalid_output")})
    await interview_feedback.run(make_ctx(db, storage, RecordingFactory(client)), "a1", "a1")
    a = await db.fetchone("SELECT status, error, completed_at FROM interview_answers WHERE id = 'a1'")
    assert a is not None and a["status"] == "failed" and a["completed_at"] is not None
    assert a["error"] == "피드백을 만들지 못했습니다. AI 응답이 정해진 형식과 맞지 않았습니다(재요청 후에도 실패). 다시 시도해 주세요."
    q = await db.fetchone("SELECT attempt_count FROM interview_questions WHERE id = 'q1'")
    assert q == {"attempt_count": 0}


async def test_feedback_isolation(db: Database, storage: Storage) -> None:
    # ub의 세션·질문
    await ready_session_with_question(db, storage, user=UB, sid="sb", qid="qb")
    await ready_session_with_question(db, storage)
    # (조작된 행) ua 답변인데 ub 세션을 가리킨다 → 세션 JOIN 조건(s.user_id = a.user_id)에 걸려 실행하지 않는다.
    await seed_answer(db, aid="a1", sid="sb", qid="qb")
    # ua 세션 답변인데 질문은 ub 세션의 것 → 질문 소유 확인에서 막고 실패로 남긴다(질문 내용을 LLM에 넘기지 않는다).
    await seed_answer(db, aid="a2", sid="s1", qid="qb")
    factory = RecordingFactory()
    ctx = make_ctx(db, storage, factory)
    assert await interview_feedback.KIND.precheck(ctx, "a1", "a1") is None
    await interview_feedback.run(ctx, "a1", "a1")
    await interview_feedback.run(ctx, "a2", "a2")
    assert factory.created == []
    a1 = await db.fetchone("SELECT status FROM interview_answers WHERE id = 'a1'")
    a2 = await db.fetchone("SELECT status, error FROM interview_answers WHERE id = 'a2'")
    assert a1 == {"status": "pending"}
    assert a2 == {"status": "failed", "error": "질문을 찾을 수 없습니다."}


async def test_feedback_without_snapshot_still_runs_and_drops_refs(db: Database, storage: Storage) -> None:
    await seed_session(db, storage, status="ready", source_key=None)
    await seed_question(db)
    await seed_answer(db)
    factory = RecordingFactory()
    await interview_feedback.run(make_ctx(db, storage, factory), "a1", "a1")
    a = await db.fetchone("SELECT status, feedback FROM interview_answers WHERE id = 'a1'")
    assert a is not None and a["status"] == "done"
    assert all(p["ref"] is None for p in a["feedback"]["modelAnswer"]["points"])
    assert "(관련 서류 줄 없음)" in factory.client.calls[0].user  # type: ignore[attr-defined]


async def test_lone_surrogate_from_ts_clip_is_written_safely(db: Database, storage: Storage) -> None:
    # TS clip()이 이모지를 가르면 스냅숏 JSON에 외톨이 서로게이트(\ud83d)가 남는다. LLM에는 U+FFFD로 보내고,
    # 저장(질문·인용 jsonb·알림)도 실패하지 않아야 한다.
    snap = make_snapshot()
    snap["lines"][0]["text"] = "결제 백엔드 개발자 \ud83d"
    key = "users/ua/interview/s1/source.json"
    await storage.put_object(key, json.dumps(snap))  # JSON.stringify처럼 \ud83d 이스케이프로 쓴다
    await seed_session(db, storage, source_key=key, snapshot=None)

    def handler(req: LlmRequest) -> dict[str, Any]:
        q = {"category": "line", "facet": "why", "question": "결제 \ud83d 질문?", "intent": "\ud83d", "citations": [{"ref": "r2", "quote": "정산 시스템"}], "followUps": ["\ude00"]}
        return {"questions": [q], "notes": []}

    client = FakeLlmClient({"interview-questions": handler})
    await interview_questions.run(make_ctx(db, storage, RecordingFactory(client)), "s1", "run1")
    assert "\ud83d" not in client.calls[0].user
    assert (await session(db))["status"] == "ready"
    row = await db.fetchone("SELECT question, intent, follow_ups FROM interview_questions WHERE session_id = 's1'")
    assert row == {"question": "결제 \ufffd 질문?", "intent": "\ufffd", "follow_ups": ["\ufffd"]}


# ---------------------------------------------------------------------------
# 시작 선점(TS claimGenerationRun·claimAnswerRun과 같은 SQL) — 워커와 Vercel 중 한쪽만 LLM을 부른다
# ---------------------------------------------------------------------------


async def test_questions_claim_only_one_llm_call(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    client = FakeLlmClient({"interview-questions": questions_handler}, delay_sec=0.05)
    ctx = make_ctx(db, storage, RecordingFactory(client))
    await asyncio.gather(*(interview_questions.run(ctx, "s1", "run1") for _ in range(3)))
    assert len(client.calls) == 1
    s = await session(db)
    # 완료 기록이 usage를 사용량 4칸으로 다시 써 선점 표시가 남지 않는다.
    assert s["status"] == "ready" and set(s["usage"]) == {"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"}


async def test_questions_vercel_claimed_first_worker_skips(db: Database, storage: Storage) -> None:
    await seed_session(db, storage)
    ctx = make_ctx(db, storage)
    assert await store_claim_generation(ctx, UA, "s1", "run1", "vercel") is True
    factory = RecordingFactory()
    ctx.llm = factory  # type: ignore[assignment]
    await interview_questions.run(ctx, "s1", "run1")
    assert factory.created == []
    s = await session(db)
    assert s["status"] == "generating" and s["usage"]["claimRunId"] == "run1" and s["usage"]["runner"] == "vercel"
    assert s["usage"]["outputTokens"] == 2  # 기존 사용량은 그대로
    # 다른 사용자 id·다른 runId로는 선점하지 못한다. 다시 만들기(새 runId)는 다시 선점할 수 있다.
    assert await store_claim_generation(ctx, UB, "s1", "run1") is False
    await db.execute("UPDATE interview_sessions SET run_id = 'run2' WHERE id = 's1'")
    assert await store_claim_generation(ctx, UA, "s1", "run1") is False
    assert await store_claim_generation(ctx, UA, "s1", "run2") is True


async def test_feedback_claim_only_one_llm_call_and_retry_reclaims(db: Database, storage: Storage) -> None:
    from app.jobs import interview_store as store

    await ready_session_with_question(db, storage)
    await seed_answer(db)
    client = FakeLlmClient({"interview-feedback": feedback_handler}, delay_sec=0.05)
    ctx = make_ctx(db, storage, RecordingFactory(client))
    await asyncio.gather(*(interview_feedback.run(ctx, "a1", "a1") for _ in range(3)))
    assert len(client.calls) == 1

    # Vercel이 먼저 선점한 시도는 워커가 건너뛴다. 다시 받기(created_at을 지금으로)는 새 시도라 다시 선점할 수 있다.
    await seed_answer(db, aid="a2")
    assert await store.claim_answer_run(ctx, UA, "a2", "vercel") is True
    assert await store.claim_answer_run(ctx, UB, "a2") is False
    await interview_feedback.run(ctx, "a2", "a2")
    assert len(client.calls) == 1
    a2 = await db.fetchone("SELECT status FROM interview_answers WHERE id = 'a2'")
    assert a2 == {"status": "pending"}
    await db.execute("UPDATE interview_answers SET created_at = created_at + interval '1 second' WHERE id = 'a2'")
    await interview_feedback.run(ctx, "a2", "a2")
    assert len(client.calls) == 2
    a2 = await db.fetchone("SELECT status FROM interview_answers WHERE id = 'a2'")
    assert a2 == {"status": "done"}


async def store_claim_generation(ctx: WorkerContext, user_id: str, sid: str, run_id: str, runner: str = "worker") -> bool:
    from app.jobs import interview_store as store

    return await store.claim_generation_run(ctx, user_id, sid, run_id, runner)
