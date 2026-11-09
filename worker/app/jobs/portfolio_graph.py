"""작업 종류 'portfolio-graph' — 경험 그래프로 포트폴리오 만들기(portfolio_draft_jobs). TS src/lib/portfolios/graph-jobs.ts
runGraphPortfolioJob과 graph-material.ts generateGraphPortfolio를 옮긴 것.

흐름: 작업 행 읽기 → claim(조건부 UPDATE, 한쪽만 이긴다) → 자료 모으기('material') → AI 작성('writing') → 저장('saving')
→ 'completed'(포트폴리오 id) / 'failed'(한국어 문구) → 알림.

보안·일관성 규칙:
- 요청 본문은 (id, runId)뿐이다. user_id·provider·input은 모두 작업 행에서 읽는다.
- 이 작업 행은 처음부터 'running'이라(queued 없음) status만으로는 Vercel after() 경로와 함께 실행될 수 있다. 그래서 TS와 같은 claim SQL
  (result.claimRunId가 아직 이 run_id가 아닐 때만 적는다)로 시작하고, 지면 아무것도 쓰지 않는다. 이후 모든 쓰기는
  WHERE id·user_id·run_id·status='running' 조건(TS `mine`)이다 — 그사이 멈춤 판정·다시 시도로 바뀌었으면 0행이라 끝낸다.
- 그래프는 그 사용자의 것만 읽고 assert_graph_owner로 확인한다. 공고·저장소·포트폴리오도 user_id 조건으로만 읽고 쓴다.
- 로그에는 작업 id와 오류 이름만 남긴다(프롬프트·본문 금지).

시간 상한: Vercel 쪽 멈춤 판정(graphPortfolioStaleMs = 시간 상한 + 60초, VERCEL에서 330초)이 그대로라, 워커도 TS의 Vercel 시간 상한
(시작 시각부터 270초)을 쓴다. 더 길게 쓰려면 TS 멈춤 판정을 먼저 바꿔야 한다.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from app.jobs.base import JobKind, WorkerContext, table_precheck
from app.jobs.portfolio_graph_material import PortfolioMaterial, load_portfolio_material
from app.jobs.portfolio_graph_output import (
    TIMEOUT_MESSAGE,
    PortfolioJobError,
    graph_portfolio_error_message,
    graph_portfolio_to_markdown,
    parse_start_input,
    sanitize_portfolio_output,
)
from app.jobs.portfolio_graph_store import (
    create_graph_portfolio,
    discard_portfolio,
    now_utc,
    replace_portfolio_text,
    strip_nul,
    strip_nul_deep,
)
from app.llm import LlmPermanentError, LlmRequest, LlmUsageContext, load_output_schema
from app.notifications import NewNotification, notify
from app.prompts.portfolio_graph import build_graph_portfolio_prompt

log = logging.getLogger("worker.jobs.portfolio_graph")

KIND_NAME = "portfolio-graph"
TABLE = "portfolio_draft_jobs"
#: 사용량 기록 task(TS generateGraphPortfolio).
LLM_TASK = "portfolio-draft"
LLM_MAX_TOKENS = 128_000
#: TS graphPortfolioTimeLimitMs(VERCEL) = max(30, 300 - 30) * 1000. 멈춤 판정이 Vercel 값이므로 같게 둔다.
TIME_LIMIT_MS = 270_000
DEFAULT_LABEL = "경험 그래프 포트폴리오"
BAD_INPUT_MESSAGE = "작업 입력을 읽지 못했습니다. 포트폴리오 화면에서 다시 만들어 주세요."
RUNNER = "worker"

_MINE = "id = %(id)s AND user_id = %(user_id)s AND run_id = %(run_id)s AND status = 'running'"
_READ_ROW = f"SELECT id, user_id, run_id, status, label, input, provider, started_at FROM {TABLE} WHERE id = %(id)s AND run_id = %(run_id)s AND status = 'running'"
#: TS claimGraphPortfolioRun과 같은 SQL(runner 값만 다르다).
_CLAIM = (
    f"UPDATE {TABLE} SET result = jsonb_build_object('claimRunId', run_id, 'runner', %(runner)s::text) "
    f"WHERE {_MINE} AND (result IS NULL OR result->>'claimRunId' IS DISTINCT FROM run_id)"
)
_SET_STAGE = f"UPDATE {TABLE} SET stage = %(stage)s, updated_at = %(now)s WHERE {_MINE}"
_COMPLETE = (
    f"UPDATE {TABLE} SET status = 'completed', stage = 'saving', error = NULL, portfolio_id = %(portfolio_id)s, result = %(result)s, "
    f"input = NULL, completed_at = %(now)s, updated_at = %(now)s WHERE {_MINE}"
)
_FAIL = f"UPDATE {TABLE} SET status = 'failed', error = %(error)s, updated_at = %(now)s WHERE {_MINE}"
_USER = "SELECT id, name FROM users WHERE id = %(id)s"


class _Superseded(Exception):
    """멈춤 판정·다시 시도로 이 실행이 버려졌다(쓰기 0행)."""


def _notify_failed(ctx: WorkerContext, user_id: str, job_id: str, label: str, error: str) -> Any:
    return notify(
        ctx.db,
        user_id,
        NewNotification(kind="portfolio-draft-failed", title="경험 그래프 포트폴리오를 만들지 못했습니다", body=f"{label} — {error}", link=f"/app/portfolios/drafts/{job_id}"),
    )


async def generate_graph_portfolio(client: Any, material: PortfolioMaterial, *, title: str, notes: str | None, template_id: str | None) -> dict[str, Any]:
    """TS generateGraphPortfolio: 프롬프트 → LLM(구조화 출력) → 출력 정리."""
    system, user = build_graph_portfolio_prompt(material, title=title, notes=notes, template_id=template_id)
    res = await client.generate(
        LlmRequest(system=system, user=user, schema=load_output_schema("graph_portfolio_output"), effort="medium", task=LLM_TASK, max_tokens=LLM_MAX_TOKENS)
    )
    return sanitize_portfolio_output(res.output, material, template_id)


def _started_ms(row: dict[str, Any]) -> float:
    v = row.get("started_at")
    return v.timestamp() * 1000 if v is not None else time.time() * 1000


async def run(ctx: WorkerContext, job_id: str, run_id: str, *, time_limit_ms: int = TIME_LIMIT_MS) -> None:
    """백그라운드 실행. 던지지 않는다. 이미 끝났거나 runId가 바뀌었거나 다른 실행이 맡았으면 아무것도 쓰지 않는다."""
    row = await ctx.db.fetchone(_READ_ROW, {"id": job_id, "run_id": run_id})
    if not row or not row.get("user_id"):
        return
    # 이후 모든 쓰기의 사용자는 이 작업 행의 user_id다(요청 본문 값이 아니다).
    user_id: str = row["user_id"]
    mine = {"id": job_id, "user_id": user_id, "run_id": run_id}
    if await ctx.db.execute(_CLAIM, {**mine, "runner": RUNNER}) == 0:
        return

    async def set_stage(stage: str) -> None:
        if await ctx.db.execute(_SET_STAGE, {**mine, "stage": stage, "now": now_utc()}) == 0:
            raise _Superseded()

    label = DEFAULT_LABEL
    created_id: str | None = None
    try:
        label = row["label"]
        input_ = parse_start_input(row.get("input"))
        if input_ is None:
            raise PortfolioJobError(BAD_INPUT_MESSAGE, 400)
        user = await ctx.db.fetchone(_USER, {"id": user_id})
        if not user:
            return

        material = await load_portfolio_material(ctx, user_id, user.get("name"), input_)
        await set_stage("writing")

        client = ctx.llm.create(row.get("provider"), LlmUsageContext(user_id=user_id, reference_id=job_id))
        remaining_ms = min(time_limit_ms, max(1_000, _started_ms(row) + time_limit_ms - time.time() * 1000))
        try:
            output = await asyncio.wait_for(
                generate_graph_portfolio(client, material, title=label, notes=input_.get("notes"), template_id=input_["templateId"]),
                timeout=remaining_ms / 1000,
            )
        except TimeoutError as err:
            raise PortfolioJobError(TIMEOUT_MESSAGE, 504) from err
        await set_stage("saving")

        text = graph_portfolio_to_markdown(
            output, title=label, person_name=material.person_name, links=material.links, contact_links=material.contact_links, template_id=input_["templateId"]
        )
        source = {
            "projectIds": input_["projectIds"],
            # 그사이 공고가 지워졌으면 공고 없이 만든 것으로 남긴다.
            "postingId": input_.get("postingId") if material.posting else None,
            "notes": input_.get("notes") or "",
            "templateId": input_["templateId"],
            "missingInfo": output["missingInfo"],
            "generatedAt": int(time.time() * 1000),
        }
        regenerate = bool(input_.get("portfolioId"))
        result = Jsonb(strip_nul_deep({"notes": output["notes"], "missingInfo": output["missingInfo"], "regenerate": regenerate}))

        def complete_params(portfolio_id: str) -> dict[str, Any]:
            return {**mine, "portfolio_id": portfolio_id, "result": result, "now": now_utc()}

        if regenerate:
            # 다시 만들기: 본문 바꾸기와 완료 기록을 한 트랜잭션에서 한다(완료 기록이 0행이면 본문 바꾸기도 되돌린다).
            target: str = input_["portfolioId"]

            async def commit(conn: AsyncConnection) -> bool:
                cur = await conn.execute(_COMPLETE, complete_params(target))
                return cur.rowcount > 0

            replaced = await replace_portfolio_text(ctx, user_id, target, text, source=source, commit=commit)
            if replaced.result == "aborted":
                return
            if replaced.result == "not_found":
                raise PortfolioJobError("다시 만들 포트폴리오가 지워졌습니다. 보관함에서 새로 만들어 주세요.", 404)
            if replaced.result == "not_graph":
                raise PortfolioJobError("포트폴리오 내용이 파일·링크로 바뀌어 다시 만들지 않았습니다.", 409)
            if replaced.result == "conflict":
                raise PortfolioJobError("그사이 포트폴리오 본문이 다른 저장으로 바뀌어 덮어쓰지 않았습니다. 다시 시도해 주세요.", 409)
            portfolio_id = target
        else:
            portfolio_id = await create_graph_portfolio(ctx, user_id, title=label, text=text, source=source)
            created_id = portfolio_id
            if await ctx.db.execute(_COMPLETE, complete_params(portfolio_id)) == 0:
                await discard_portfolio(ctx, user_id, portfolio_id)
                created_id = None
                return
            created_id = None

        missing = output["missingInfo"]
        await notify(
            ctx.db,
            user_id,
            NewNotification(
                kind="portfolio-draft-completed",
                title="포트폴리오를 다시 만들었습니다" if regenerate else "경험 그래프 포트폴리오가 완성됐습니다",
                body=f"{label} — 채워야 할 정보 {len(missing)}개" if missing else label,
                link=f"/app/portfolios/{portfolio_id}",
            ),
        )
    except _Superseded:
        if created_id:
            await discard_portfolio(ctx, user_id, created_id)
        return
    except Exception as err:  # noqa: BLE001 — 실패는 작업 행에 기록한다(던지지 않는다)
        if created_id:
            await discard_portfolio(ctx, user_id, created_id)
        if not isinstance(err, (LlmPermanentError, PortfolioJobError)):
            log.error("portfolio_graph_error id=%s error=%s", job_id, type(err).__name__)
        message = graph_portfolio_error_message(err)
        try:
            count = await ctx.db.execute(_FAIL, {**mine, "error": strip_nul(message), "now": now_utc()})
        except Exception as db_err:  # noqa: BLE001
            log.error("portfolio_graph_fail_write_failed id=%s error=%s", job_id, type(db_err).__name__)
            count = 0
        if count > 0:
            await _notify_failed(ctx, user_id, job_id, label, message)


async def _run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
    await run(ctx, job_id, run_id)


KIND = JobKind(name=KIND_NAME, run=_run, precheck=table_precheck(TABLE, ("running",)))
