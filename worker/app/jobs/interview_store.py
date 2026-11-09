"""면접 연습 저장소(interview_sessions·interview_questions·interview_answers + 저장소 스냅숏) — TS src/lib/interview/store.ts 중
백그라운드 실행부가 쓰는 함수의 워커판. SQL 의미는 Prisma 호출과 같다.

- 생성 결과 쓰기(complete_generation·fail_generation)는 세션의 run_id가 같고 status='generating'일 때만 한다(다시 만들기·삭제와 겹친
  늦은 결과, Vercel after() 경로와 겹친 실행 중 한쪽을 버린다). 피드백 쓰기(complete_answer·fail_answer)는 답변이 'pending'일 때만 한다.
- 사용자 진입 함수(load_source_snapshot·get_question·load_answer)는 user_id 조건을 SQL에 건다. user_id는 호출자가 DB 작업 행에서 읽은 값이다.
- 스냅숏 키는 DB 행에 적힌 값이라도 users/<user_id>/ 아래인지 assert_user_key로 다시 확인한다(다른 사용자 자료 격리).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from psycopg.types.json import Jsonb

from app.jobs.interview_domain import INTERVIEW_LIMITS, parse_source_snapshot, strip_nul, strip_nul_deep
from app.jsutil import js_slice
from app.llm.pricing import js_round
from app.storage import StorageKeyError, assert_user_key

if TYPE_CHECKING:
    from app.jobs.base import WorkerContext

# TS customAlphabet("0-9A-Za-z", 16) — 저장소 키 조각에 쓰므로 '-'·'_' 없는 알파벳.
_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def new_id() -> str:
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(16))


def _now() -> datetime:
    # Prisma는 timestamptz(3)에 앱 시각(ms)을 쓴다. 같은 정밀도로 맞춘다.
    n = datetime.now(UTC)
    return n.replace(microsecond=(n.microsecond // 1000) * 1000)


_USAGE_KEYS = ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens")


def add_usage(a: Any, b: dict[str, int] | None) -> dict[str, int] | None:
    """TS addUsage(UsageTotals | null, UsageTotals | null | undefined): b가 없으면 a 그대로."""
    if not b:
        return a if isinstance(a, dict) else None
    base = a if isinstance(a, dict) else {}

    def n(d: dict[str, Any], k: str) -> int | float:
        v = d.get(k)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

    return {k: n(base, k) + n(b, k) for k in _USAGE_KEYS}


def _error_text(error: str) -> str:
    return strip_nul(js_slice(error, 0, 500)) or ""


# ---------------------------------------------------------------------------
# 스냅숏
# ---------------------------------------------------------------------------


async def load_source_snapshot(ctx: WorkerContext, user_id: str, session_id: str) -> dict[str, Any] | None:
    """저장된 스냅숏. 세션이 그 사용자 것이 아니거나 스냅숏이 없거나 형식이 틀리면 None."""
    row = await ctx.db.fetchone(
        "SELECT source_key FROM interview_sessions WHERE id = %(id)s AND user_id = %(user_id)s",
        {"id": session_id, "user_id": user_id},
    )
    key = row.get("source_key") if row else None
    if not key:
        return None
    try:
        assert_user_key(user_id, key)
    except StorageKeyError:
        return None
    raw = await ctx.storage.get_json(key)
    return parse_source_snapshot(raw)


# ---------------------------------------------------------------------------
# 생성
# ---------------------------------------------------------------------------


async def complete_generation(
    ctx: WorkerContext,
    session_id: str,
    run_id: str,
    questions: list[dict[str, Any]],
    *,
    usage: dict[str, int] | None = None,
    model: str | None = None,
) -> bool:
    """기존 질문을 지우고 새 질문을 넣은 뒤 세션을 'ready'로. run_id가 다르거나 이미 끝났으면 False(버린다). 질문 0개면 False."""
    if not questions:
        return False
    now = _now()
    async with ctx.db.connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                "SELECT usage FROM interview_sessions WHERE id = %(id)s AND run_id = %(run_id)s AND status = 'generating' FOR UPDATE",
                {"id": session_id, "run_id": run_id},
            )
            row = await cur.fetchone()
            if row is None:
                return False
            next_usage = add_usage(row.get("usage"), usage)
            sets = ["status = 'ready'", "error = NULL", "question_count = %(n)s", "answered_count = 0", "generated_at = %(now)s", "updated_at = %(now)s"]
            params: dict[str, Any] = {"id": session_id, "run_id": run_id, "n": len(questions), "now": now}
            if next_usage is not None:
                sets.append("usage = %(usage)s")
                params["usage"] = Jsonb(next_usage)
            if model:
                sets.append("model = %(model)s")
                params["model"] = model
            upd = await conn.execute(
                f"UPDATE interview_sessions SET {', '.join(sets)} WHERE id = %(id)s AND run_id = %(run_id)s AND status = 'generating'",
                params,
            )
            if upd.rowcount == 0:
                return False
            await conn.execute("DELETE FROM interview_questions WHERE session_id = %(id)s", {"id": session_id})
            rows = [
                {
                    "id": new_id(),
                    "session_id": session_id,
                    "ord": ord_,
                    "category": q["category"],
                    "facet": q["facet"],
                    "question": strip_nul(q["question"]),
                    "intent": strip_nul(q["intent"]),
                    "citations": Jsonb(strip_nul_deep(q["citations"])),
                    "follow_ups": Jsonb(strip_nul_deep(q["followUps"])),
                    "created_at": now,
                }
                for ord_, q in enumerate(questions[: INTERVIEW_LIMITS.questionsPerSession])
            ]
            async with conn.cursor() as c:
                await c.executemany(
                    "INSERT INTO interview_questions (id, session_id, ord, category, facet, question, intent, citations, follow_ups, created_at) "
                    "VALUES (%(id)s, %(session_id)s, %(ord)s, %(category)s, %(facet)s, %(question)s, %(intent)s, %(citations)s, %(follow_ups)s, %(created_at)s)",
                    rows,
                )
    return True


#: TS store.ts claimGenerationRun과 같은 SQL(usage jsonb에 이 run_id를 적는 조건부 UPDATE — 이긴 한쪽만 LLM을 부른다). updated_at은 건드리지 않는다.
_CLAIM_GENERATION = (
    "UPDATE interview_sessions SET usage = (CASE WHEN jsonb_typeof(usage) = 'object' THEN usage ELSE '{}'::jsonb END) "
    "|| jsonb_build_object('claimRunId', run_id, 'runner', %(runner)s::text) "
    "WHERE id = %(id)s AND user_id = %(user_id)s AND run_id = %(run_id)s AND status = 'generating' "
    "AND (usage IS NULL OR jsonb_typeof(usage) <> 'object' OR usage->>'claimRunId' IS DISTINCT FROM run_id)"
)

#: TS store.ts claimAnswerRun과 같은 SQL. 답변에는 run_id가 없어 시도마다 바뀌는 created_at(ms)을 시도 표시로 쓴다.
_CLAIM_ANSWER = (
    "UPDATE interview_answers SET usage = jsonb_build_object('claimAttempt', (extract(epoch FROM created_at) * 1000)::bigint::text, 'runner', %(runner)s::text) "
    "WHERE id = %(id)s AND user_id = %(user_id)s AND status = 'pending' "
    "AND (usage IS NULL OR jsonb_typeof(usage) <> 'object' "
    "OR usage->>'claimAttempt' IS DISTINCT FROM (extract(epoch FROM created_at) * 1000)::bigint::text)"
)


async def claim_generation_run(ctx: WorkerContext, user_id: str, session_id: str, run_id: str, runner: str = "worker") -> bool:
    """생성 시작 선점. 진 쪽(False)은 아무것도 하지 않는다. user_id는 호출자가 DB 세션 행에서 읽은 값이다."""
    return await ctx.db.execute(_CLAIM_GENERATION, {"id": session_id, "user_id": user_id, "run_id": run_id, "runner": runner}) > 0


async def claim_answer_run(ctx: WorkerContext, user_id: str, answer_id: str, runner: str = "worker") -> bool:
    """피드백 시작 선점. 진 쪽(False)은 LLM을 부르지 않는다. user_id는 호출자가 DB 답변 행에서 읽은 값이다."""
    return await ctx.db.execute(_CLAIM_ANSWER, {"id": answer_id, "user_id": user_id, "runner": runner}) > 0


async def fail_generation(ctx: WorkerContext, session_id: str, run_id: str, error: str) -> bool:
    """생성 실패 기록(사용자에게 보여도 되는 문구). run_id가 다르거나 'generating'이 아니면 False."""
    n = await ctx.db.execute(
        "UPDATE interview_sessions SET status = 'failed', error = %(error)s, updated_at = %(now)s "
        "WHERE id = %(id)s AND run_id = %(run_id)s AND status = 'generating'",
        {"id": session_id, "run_id": run_id, "error": _error_text(error), "now": _now()},
    )
    return n > 0


async def session_title(ctx: WorkerContext, user_id: str, session_id: str) -> str | None:
    row = await ctx.db.fetchone(
        "SELECT title FROM interview_sessions WHERE id = %(id)s AND user_id = %(user_id)s",
        {"id": session_id, "user_id": user_id},
    )
    return row["title"] if row else None


# ---------------------------------------------------------------------------
# 답변·피드백
# ---------------------------------------------------------------------------


async def load_answer(ctx: WorkerContext, answer_id: str, user_id: str) -> dict[str, Any] | None:
    return await ctx.db.fetchone(
        "SELECT id, question_id, session_id, user_id, answer, duration_sec, status FROM interview_answers WHERE id = %(id)s AND user_id = %(user_id)s",
        {"id": answer_id, "user_id": user_id},
    )


def _strings(v: Any) -> list[str]:
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def _citations(v: Any) -> list[dict[str, Any]]:
    if not isinstance(v, list):
        return []
    return [c for c in v if isinstance(c, dict) and isinstance(c.get("ref"), str) and isinstance(c.get("quote"), str)]


async def get_question(ctx: WorkerContext, user_id: str, session_id: str, question_id: str) -> dict[str, Any] | None:
    """TS getQuestion(ownedQuestion): 질문 id·세션 id가 맞고 세션이 그 사용자 것일 때만. 보기 형태(category·facet·question·intent·citations·followUps)."""
    row = await ctx.db.fetchone(
        "SELECT q.id, q.category, q.facet, q.question, q.intent, q.citations, q.follow_ups FROM interview_questions q "
        "JOIN interview_sessions s ON s.id = q.session_id "
        "WHERE q.id = %(qid)s AND q.session_id = %(sid)s AND s.user_id = %(user_id)s",
        {"qid": question_id, "sid": session_id, "user_id": user_id},
    )
    if row is None:
        return None
    return {
        "id": row["id"],
        "category": row["category"],
        "facet": row["facet"],
        "question": row["question"],
        "intent": row["intent"],
        "citations": _citations(row["citations"]),
        "followUps": _strings(row["follow_ups"]),
    }


async def complete_answer(
    ctx: WorkerContext,
    answer_id: str,
    feedback: dict[str, Any],
    *,
    provider: str | None = None,
    model: str | None = None,
    usage: dict[str, int] | None = None,
) -> bool:
    """답변을 'done'으로, 질문의 시도 수·최고 점수·마지막 답변 시각·상태(new → practiced)와 세션의 진행 수·사용량을 갱신한다. 'pending'이 아니면 False."""
    now = _now()
    score = max(0, min(100, js_round(feedback["overall"])))
    async with ctx.db.connection() as conn:
        async with conn.transaction():
            sets = [
                "status = 'done'",
                "feedback = %(feedback)s",
                "score = %(score)s",
                "error = NULL",
                "provider = %(provider)s",
                "model = %(model)s",
                "completed_at = %(now)s",
            ]
            params: dict[str, Any] = {
                "id": answer_id,
                "feedback": Jsonb(strip_nul_deep(feedback)),
                "score": score,
                "provider": provider,
                "model": model,
                "now": now,
            }
            if usage is not None:
                sets.append("usage = %(usage)s")
                params["usage"] = Jsonb(usage)
            cur = await conn.execute(
                f"UPDATE interview_answers SET {', '.join(sets)} WHERE id = %(id)s AND status = 'pending' RETURNING question_id, session_id",
                params,
            )
            a = await cur.fetchone()
            if a is None:
                return False
            cur = await conn.execute("SELECT id, best_score, status FROM interview_questions WHERE id = %(id)s FOR UPDATE", {"id": a["question_id"]})
            q = await cur.fetchone()
            if q is not None:
                best = score if q["best_score"] is None else max(q["best_score"], score)
                await conn.execute(
                    "UPDATE interview_questions SET attempt_count = attempt_count + 1, best_score = %(best)s, last_answered_at = %(now)s"
                    + (", status = 'practiced'" if q["status"] == "new" else "")
                    + " WHERE id = %(id)s",
                    {"id": q["id"], "best": best, "now": now},
                )
            cur = await conn.execute(
                "SELECT count(*)::int AS n FROM interview_questions WHERE session_id = %(sid)s AND attempt_count > 0",
                {"sid": a["session_id"]},
            )
            answered = (await cur.fetchone())["n"]
            cur = await conn.execute("SELECT usage FROM interview_sessions WHERE id = %(sid)s FOR UPDATE", {"sid": a["session_id"]})
            s = await cur.fetchone()
            next_usage = add_usage(s.get("usage") if s else None, usage)
            s_sets = ["answered_count = %(answered)s", "updated_at = %(now)s"]
            s_params: dict[str, Any] = {"sid": a["session_id"], "answered": answered, "now": now}
            if next_usage is not None:
                s_sets.append("usage = %(usage)s")
                s_params["usage"] = Jsonb(next_usage)
            # TS는 update(where id) — 세션이 없으면 던져 트랜잭션 전체가 되돌아간다. 같은 동작: 0행이면 예외.
            upd = await conn.execute(f"UPDATE interview_sessions SET {', '.join(s_sets)} WHERE id = %(sid)s", s_params)
            if upd.rowcount == 0:
                raise LookupError("interview session not found")
    return True


async def fail_answer(ctx: WorkerContext, answer_id: str, error: str) -> bool:
    """피드백 실패 기록. 'pending'이 아니면 False."""
    n = await ctx.db.execute(
        "UPDATE interview_answers SET status = 'failed', error = %(error)s, completed_at = %(now)s WHERE id = %(id)s AND status = 'pending'",
        {"id": answer_id, "error": _error_text(error), "now": _now()},
    )
    return n > 0

