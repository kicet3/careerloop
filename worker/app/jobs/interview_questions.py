"""작업 종류 'interview-questions' — TS src/lib/interview/service.ts runInterviewGeneration의 워커판.

흐름: 세션 행(id·run_id·status='generating')에서 user_id·provider를 읽는다 → 스냅숏 읽기(user_id 소유 + 키 접두사 확인) → LLM →
normalize_generated_questions → complete_generation / fail_generation(run_id·'generating' 조건) → 알림.

- 디스패치 본문의 id는 세션 id, runId는 세션의 run_id다(TS startInterviewSession·restartInterviewGeneration이 만든 값).
- user_id는 요청 본문이 아니라 세션 행에서 읽는다. 행이 없거나(다른 run_id·이미 끝남) 엔진이 'anthropic'이 아니면 아무것도 쓰지 않고 끝낸다.
- 시작할 때 claim_generation_run(TS claimGenerationRun과 같은 조건부 UPDATE)으로 선점한다. Vercel after() 경로와 겹쳐도 이긴 한쪽만
  LLM을 부른다. 결과 쓰기도 complete_generation의 조건부 UPDATE(run_id·'generating')로 한 번 더 막는다.
"""

from __future__ import annotations

import logging

from app.jobs import interview_store as store
from app.jobs.base import JobKind, WorkerContext, table_precheck
from app.jobs.interview_common import (
    INTERACTIVE_LLM_TIMEOUT_SEC,
    QUESTIONS_MAX_TOKENS,
    generate_with_deadline,
    save_once,
    swallow,
)
from app.jobs.interview_domain import interview_error_message, normalize_generated_questions, well_formed
from app.llm.schemas import load_output_schema
from app.llm.types import WORKER_PROVIDER, LlmRequest
from app.llm.usage import LlmUsageContext
from app.notifications import NewNotification, notify
from app.prompts.interview import build_interview_questions_prompt

log = logging.getLogger("worker.jobs.interview")

KIND_NAME = "interview-questions"
TIMEOUT_MESSAGE = "질문을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 만들어 주세요."
NO_SNAPSHOT_MESSAGE = "근거 자료를 찾지 못했습니다. 새 연습을 만들어 주세요."
NO_QUESTIONS_MESSAGE = "서류에서 근거를 확인할 수 있는 질문을 만들지 못했습니다. 다시 만들어 주세요."

#: 테스트에서 줄인다.
timeout_sec = INTERACTIVE_LLM_TIMEOUT_SEC

_JOB_ROW = "SELECT id, user_id, provider FROM interview_sessions WHERE id = %(id)s AND run_id = %(run_id)s AND status = 'generating'"


async def _notify_generation(ctx: WorkerContext, user_id: str, session_id: str, *, count: int | None = None, error: str | None = None) -> None:
    """질문 생성이 끝났다는 알림(TS notifyGeneration). 던지지 않는다."""
    try:
        title = await store.session_title(ctx, user_id, session_id)
    except Exception:  # noqa: BLE001
        return
    if title is None:
        return
    ok = error is None
    await notify(
        ctx.db,
        user_id,
        NewNotification(
            kind="interview-ready" if ok else "interview-failed",
            title="면접 예상 질문이 준비됐습니다" if ok else "면접 예상 질문을 만들지 못했습니다",
            body=f"{title} — 질문 {count}개" if ok else f"{title} — {error}",
            link=f"/app/interview/{session_id}",
        ),
    )


async def run(ctx: WorkerContext, session_id: str, run_id: str) -> None:
    """던지지 않는다(취소 제외). 실패는 세션 행에 기록한다."""
    row = await ctx.db.fetchone(_JOB_ROW, {"id": session_id, "run_id": run_id})
    if row is None or not row.get("user_id"):
        return
    user_id: str = row["user_id"]
    if row.get("provider") != WORKER_PROVIDER:
        log.warning("interview_questions_skip id=%s reason=provider", session_id)
        return
    try:
        if not await store.claim_generation_run(ctx, user_id, session_id, run_id):
            log.info("interview_questions_skip id=%s reason=claimed", session_id)
            return
        snapshot = await store.load_source_snapshot(ctx, user_id, session_id)
        if snapshot is None:
            await store.fail_generation(ctx, session_id, run_id, NO_SNAPSHOT_MESSAGE)
            return
        client = ctx.llm.create(row["provider"], LlmUsageContext(user_id=user_id, reference_id=session_id))
        system, user = build_interview_questions_prompt(snapshot)
        req = LlmRequest(
            system=system,
            # 외톨이 서로게이트(TS 스냅숏의 이모지 자르기)는 HTTP 본문 UTF-8 인코딩에서 실패하므로 U+FFFD로 바꿔 보낸다.
            user=well_formed(user),
            schema=load_output_schema("interview_questions_output"),
            effort="medium",
            task=KIND_NAME,
            max_tokens=QUESTIONS_MAX_TOKENS,
            cache_user=False,
        )
        res = await generate_with_deadline(client, req, timeout_sec=timeout_sec, message=TIMEOUT_MESSAGE)
        questions = normalize_generated_questions(res.output, snapshot["lines"])
        if not questions:
            if await store.fail_generation(ctx, session_id, run_id, NO_QUESTIONS_MESSAGE):
                await _notify_generation(ctx, user_id, session_id, error=NO_QUESTIONS_MESSAGE)
            return
        saved = await save_once(
            lambda: store.complete_generation(ctx, session_id, run_id, questions, usage=res.usage.to_dict(), model=res.model)
        )
        if not saved:
            log.warning("interview_questions_discarded id=%s", session_id)
        else:
            await _notify_generation(ctx, user_id, session_id, count=len(questions))
    except Exception as err:  # noqa: BLE001 — 실패는 세션 행에 기록한다
        log.error("interview_questions_error id=%s error=%s", session_id, type(err).__name__)
        message = interview_error_message(err, "질문")
        if await swallow(store.fail_generation(ctx, session_id, run_id, message), False):
            await _notify_generation(ctx, user_id, session_id, error=message)


KIND = JobKind(
    name=KIND_NAME,
    run=run,
    precheck=table_precheck("interview_sessions", ("generating",)),
    # 'queued' 상태가 없다(세션은 처음부터 'generating') — 스위퍼 대상이 아니다. 끊긴 작업은 6분 stale 규칙으로 '다시 만들기'가 열린다.
    sweep_query=None,
)
