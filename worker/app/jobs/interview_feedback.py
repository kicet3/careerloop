"""작업 종류 'interview-feedback' — TS src/lib/interview/service.ts runInterviewFeedback의 워커판.

디스패치 계약: 본문 id = 답변 id, runId = 답변 id(같은 값). 답변 행에는 run_id 열이 없고, 실행 가능 여부는 status='pending'으로만 정한다
(TS submitInterviewAnswer·retryInterviewFeedback이 'pending'으로 둔다). runId가 id와 다르면 받지 않는다(404 → Vercel이 직접 실행).

흐름: 답변 행(+ 같은 사용자의 세션)에서 user_id·provider를 읽는다 → 질문(세션 소유 확인) → 스냅숏(user_id 소유 + 키 접두사 확인) →
관련 근거 줄 → LLM → to_interview_feedback → complete_answer / fail_answer('pending' 조건).

- user_id는 요청 본문이 아니라 답변 행에서 읽고, 세션도 같은 user_id일 때만 쓴다(JOIN 조건).
- provider는 세션 행 값이다(TS pickSessionProvider가 세션의 엔진을 우선한다). 'anthropic'이 아니면 아무것도 쓰지 않고 끝낸다.
- 시작할 때 claim_answer_run(TS claimAnswerRun과 같은 조건부 UPDATE, 시도 표시는 created_at)으로 선점한다. Vercel 경로와 겹쳐도 이긴
  한쪽만 LLM을 부른다. 결과 쓰기도 'pending' 조건으로 한 번 더 막는다.
"""

from __future__ import annotations

import logging

from app.jobs import interview_store as store
from app.jobs.base import JobKind, JobRef, WorkerContext
from app.jobs.interview_common import (
    FEEDBACK_MAX_TOKENS,
    INTERACTIVE_LLM_TIMEOUT_SEC,
    generate_with_deadline,
    save_once,
    swallow,
)
from app.jobs.interview_domain import interview_error_message, to_interview_feedback, well_formed
from app.llm.schemas import load_output_schema
from app.llm.types import WORKER_PROVIDER, LlmRequest
from app.llm.usage import LlmUsageContext
from app.prompts.interview import build_interview_feedback_prompt, feedback_context_lines

log = logging.getLogger("worker.jobs.interview")

KIND_NAME = "interview-feedback"
TIMEOUT_MESSAGE = "피드백을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요."
NO_QUESTION_MESSAGE = "질문을 찾을 수 없습니다."

#: 테스트에서 줄인다.
timeout_sec = INTERACTIVE_LLM_TIMEOUT_SEC

_JOB_ROW = (
    "SELECT a.id, a.user_id, a.session_id, a.question_id, a.answer, a.duration_sec, a.status, s.provider "
    "FROM interview_answers a JOIN interview_sessions s ON s.id = a.session_id AND s.user_id = a.user_id "
    "WHERE a.id = %(id)s"
)


async def precheck(ctx: WorkerContext, answer_id: str, run_id: str) -> JobRef | None:
    if run_id != answer_id:
        return None
    row = await ctx.db.fetchone(_JOB_ROW, {"id": answer_id})
    if row is None or not row.get("user_id") or row.get("status") != "pending":
        return None
    return JobRef(id=row["id"], run_id=row["id"], user_id=row["user_id"], provider=row.get("provider"), status=row["status"])


async def run(ctx: WorkerContext, answer_id: str, run_id: str) -> None:
    """던지지 않는다(취소 제외). 실패는 답변 행에 기록한다."""
    if run_id != answer_id:
        return
    row = await ctx.db.fetchone(_JOB_ROW, {"id": answer_id})
    if row is None or not row.get("user_id") or row.get("status") != "pending":
        return
    user_id: str = row["user_id"]
    provider = row.get("provider")
    if provider != WORKER_PROVIDER:
        log.warning("interview_feedback_skip id=%s reason=provider", answer_id)
        return
    try:
        if not await store.claim_answer_run(ctx, user_id, answer_id):
            log.info("interview_feedback_skip id=%s reason=claimed", answer_id)
            return
        question = await store.get_question(ctx, user_id, row["session_id"], row["question_id"])
        if question is None:
            await store.fail_answer(ctx, answer_id, NO_QUESTION_MESSAGE)
            return
        snapshot = await store.load_source_snapshot(ctx, user_id, row["session_id"])
        all_lines = snapshot["lines"] if snapshot else []
        lines = feedback_context_lines(question, all_lines) if snapshot else []
        client = ctx.llm.create(provider, LlmUsageContext(user_id=user_id, reference_id=row["session_id"]))
        system, user = build_interview_feedback_prompt(question, row["answer"], row["duration_sec"], lines)
        req = LlmRequest(
            system=system,
            # 외톨이 서로게이트(TS 스냅숏의 이모지 자르기)는 HTTP 본문 UTF-8 인코딩에서 실패하므로 U+FFFD로 바꿔 보낸다.
            user=well_formed(user),
            schema=load_output_schema("interview_feedback_output"),
            effort="low",
            task=KIND_NAME,
            max_tokens=FEEDBACK_MAX_TOKENS,
            cache_user=False,
        )
        res = await generate_with_deadline(client, req, timeout_sec=timeout_sec, message=TIMEOUT_MESSAGE)
        feedback = to_interview_feedback(res.output, row["answer"], question["category"], all_lines)
        await save_once(lambda: store.complete_answer(ctx, answer_id, feedback, provider=provider, model=res.model, usage=res.usage.to_dict()))
    except Exception as err:  # noqa: BLE001 — 실패는 답변 행에 기록한다
        log.error("interview_feedback_error id=%s error=%s", answer_id, type(err).__name__)
        await swallow(store.fail_answer(ctx, answer_id, interview_error_message(err, "피드백")), False)


KIND = JobKind(
    name=KIND_NAME,
    run=run,
    precheck=precheck,
    # 'queued' 상태가 없다(답변은 처음부터 'pending') — 스위퍼 대상이 아니다. 끊긴 작업은 5분 stale 규칙으로 '다시 받기'가 열린다.
    sweep_query=None,
)
