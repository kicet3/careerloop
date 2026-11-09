"""작업 종류 'resume-draft'(AI 이력서 초안) — TS src/lib/resumes/draft-jobs.ts runResumeDraftJob·draft.ts generateResumeDraft·loadDraftMaterial의 워커판.

흐름(TS와 같다): 자료 모으기('material') → [선점] AI 초안('writing') → 저장('saving') → 'completed'(이력서 id) / 'failed'(문구). 끝나면 알림.

안전 규칙
- 요청 본문은 (id, runId)만 믿는다. user_id·provider·input은 모두 DB 작업 행에서 읽는다.
- 이 작업 행은 처음부터 'running'으로 만들어져 'queued'가 없다. 그래서 Vercel after()와 워커가 함께 시작할 수 있다 —
  'material' → 'writing' 전환(stage='material' 조건부 UPDATE)을 선점으로 삼아 한쪽만 LLM을 부르고 저장한다(TS도 같은 조건을 쓴다).
  선점 전의 실패 기록은 stage='material'일 때만 쓴다(먼저 선점한 실행을 진 쪽이 실패로 덮지 않게).
- 실행 중 모든 쓰기는 (id, user_id, run_id, status='running') 조건이다. 0행이면 다시 시도·멈춤 판정으로 이 실행이 버려진 것 — 아무것도 쓰지 않는다.
- 다른 사용자 자료: 진단·공고·이력서는 user_id 조건 SQL, 그래프는 assert_graph_owner, 저장소 키는 assert_user_key.
- 로그에는 작업 id·오류 이름만 남긴다(이력서·JD·프롬프트 본문 금지).
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from psycopg.types.json import Jsonb

from app.graph.owner import assert_graph_owner
from app.graph.service import get_career_graph
from app.graph.text import graph_to_text
from app.jobs.base import JobKind, WorkerContext, table_precheck
from app.jobs.resume_draft_output import RESUME_DRAFT_OUTPUT_SCHEMA, parse_create_resume_input, parse_rewrite_result, postprocess_draft
from app.jobs.resume_draft_resumes import (
    REGENERATE_TARGET_GONE,
    FeatureError,
    apply_regenerated_meta,
    create_resume,
    delete_resume,
    discard_regenerated_version,
    new_id,
    save_regenerated_version,
    strip_nul,
    strip_nul_deep,
)
from app.jsutil import js_len
from app.llm.types import LlmClient, LlmPermanentError, LlmRequest
from app.llm.usage import LlmUsageContext
from app.notifications import NewNotification, notify
from app.prompts.resume_draft import DraftContext, DraftMaterial, build_resume_draft_prompt, draft_context_for

log = logging.getLogger("worker.resume_draft")

KIND_NAME = "resume-draft"
TABLE = "resume_draft_jobs"

#: 자체 호스팅(워커)에서 초안 한 번에 주는 시간(TS SELF_HOSTED_DRAFT_TIME_LIMIT_MS). 작업 시작 시각(started_at)부터 잰다.
DRAFT_TIME_LIMIT_MS = 15 * 60_000
#: 그래프 텍스트 한도(TS GRAPH_TEXT_MAX).
GRAPH_TEXT_MAX = 16_000

DRAFT_TIMEOUT_MESSAGE = "AI 초안을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도하거나 빈 문서로 시작해 주세요."
CANCELLED_MESSAGE = "초안 작업이 중간에 끊겼습니다(서버 재시작 또는 시간 제한). 다시 시도해 주세요."
GRAPH_DISABLED_MESSAGE = "경험 그래프 저장소(Neo4j)가 설정되지 않아 그래프에서 초안을 만들 수 없습니다."
GRAPH_EMPTY_MESSAGE = "경험 그래프가 비어 있습니다. '경험 그래프'에서 경력·경험을 먼저 정리해 주세요."

# ---------------------------------------------------------------------------
# 실패 문구(TS draftErrorMessage·panel/runner.ts stageErrorMessage)
# ---------------------------------------------------------------------------

_PERMANENT_MESSAGES = {
    "refusal": "AI 모델이 이 단계의 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요.",
    "invalid_output": "AI 응답이 정해진 형식과 맞지 않았습니다(재요청 후에도 실패). 다시 시도해 주세요.",
    "max_tokens": "AI 응답이 서버의 출력 길이 한도에서 끊겼습니다(한도를 올려 다시 요청한 뒤에도). 다시 시도해 주세요.",
    "context_window": "이력서와 공고를 합친 입력이 AI 모델이 한 번에 읽을 수 있는 양을 넘었습니다. 줄여서 다시 진단해 주세요.",
    "bad_request": "AI 서비스가 요청을 받아들이지 않았습니다(입력이 너무 길거나 형식 오류).",
    "auth": "AI 계정 로그인이 없거나 만료되었습니다. 'AI 연결' 화면에서 다시 로그인한 뒤 재시도해 주세요.",
    "usage_limit": "연결된 AI 계정의 사용량 한도에 걸렸습니다. 한도가 풀린 뒤 다시 시도해 주세요.",
    "unavailable": "선택한 AI 엔진을 지금 쓸 수 없습니다(CLI 미설치 또는 기능 꺼짐). 'AI 연결' 화면을 확인해 주세요.",
    "timeout": "AI 응답이 제한 시간 안에 오지 않았습니다. 다시 시도해 주세요.",
}


def draft_error_message(err: BaseException) -> str:
    """사용자에게 보여도 되는 실패 문구(TS draftErrorMessage와 같은 문구)."""
    if isinstance(err, FeatureError):
        return err.message
    if isinstance(err, LlmPermanentError):
        stage_msg = _PERMANENT_MESSAGES.get(err.reason, "이 단계를 실행하는 중 오류가 발생했습니다. 다시 시도해 주세요.")
        # JS String.replace(문자열): 첫 번째만 바꾼다.
        return f"초안을 만들지 못했습니다. {stage_msg.replace('이 단계의 ', '', 1)}"
    if isinstance(err, TimeoutError):
        return "초안을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요."
    return "초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."


# ---------------------------------------------------------------------------
# 자료(loadDraftMaterial)
# ---------------------------------------------------------------------------

GraphLoader = Callable[[Any, str, str | None], Awaitable[Any]]


async def load_draft_material(ctx: WorkerContext, user: dict[str, Any], source: dict[str, Any], *, load_graph: GraphLoader = get_career_graph) -> DraftMaterial | None:
    """초안 출처에 맞는 자료. 빈 문서면 None. 자료가 없으면 FeatureError. user['id']는 DB 작업 행의 user_id다."""
    user_id = user["id"]
    kind = source.get("kind")
    if kind == "graph":
        if not ctx.graph.enabled:
            raise FeatureError(GRAPH_DISABLED_MESSAGE, 503)
        graph = assert_graph_owner(await load_graph(ctx.graph, user_id, user.get("name")), user_id)
        if len(graph.nodes) == 0:
            raise FeatureError(GRAPH_EMPTY_MESSAGE, 409)
        return DraftMaterial("graph", graph_to_text(graph, max_chars=GRAPH_TEXT_MAX))
    if kind == "diagnosis":
        d = await ctx.db.fetchone("SELECT id, title FROM diagnoses WHERE id = %s AND user_id = %s LIMIT 1", (source["diagnosisId"], user_id))
        if d is None:
            raise FeatureError("진단을 찾을 수 없습니다.", 404)
        stage = await ctx.db.fetchone(
            "SELECT output FROM diagnosis_stages WHERE diagnosis_id = %s AND stage = 'rewrite' AND status = 'done' LIMIT 1",
            (d["id"],),
        )
        rw = parse_rewrite_result(stage["output"] if stage else None)
        if rw is None or not rw.resume_markdown.strip():
            raise FeatureError("이 진단에는 아직 다시 쓴 이력서가 없습니다. 진단이 끝난 뒤 다시 시도해 주세요.", 409)
        return DraftMaterial("diagnosis", rw.resume_markdown, d["title"])
    return None


async def generate_resume_draft(client: LlmClient, ctx: DraftContext) -> dict[str, Any]:
    """LLM 1회 + 후처리(TS generateResumeDraft). 초안 dict {document, notes, missingInfo}."""
    system, user = build_resume_draft_prompt(ctx)
    res = await client.generate(
        LlmRequest(system=system, user=user, schema=RESUME_DRAFT_OUTPUT_SCHEMA, effort="medium", task="resume-draft", max_tokens=128_000)
    )
    return postprocess_draft(res.output, ctx)


# ---------------------------------------------------------------------------
# 실행
# ---------------------------------------------------------------------------


class DraftSupersededError(Exception):
    """다시 시도·멈춤 판정·다른 실행의 선점으로 이 실행이 버려졌다 — 아무것도 쓰지 않고 끝낸다."""


@dataclass
class RunDeps:
    """테스트용 주입점."""

    load_graph: GraphLoader = get_career_graph
    time_limit_ms: int = DRAFT_TIME_LIMIT_MS
    now_ms: Callable[[], float] = lambda: time.time() * 1000
    #: 이력서(또는 다시 생성 버전)를 저장한 직후, 완료 기록 전에 부른다.
    on_saved: Callable[[str], Awaitable[None]] | None = None
    #: LLM 클라이언트(기본: ctx.llm.create).
    create_client: Callable[[str, LlmUsageContext], LlmClient] | None = None


def _dt(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, UTC)


_SELECT_MINE = (
    "SELECT id, user_id, run_id, status, stage, label, input, provider, target_resume_id, result, started_at "
    "FROM resume_draft_jobs WHERE id = %(id)s AND run_id = %(run_id)s AND status = 'running'"
)
_MINE = "id = %(id)s AND user_id = %(user_id)s AND run_id = %(run_id)s AND status = 'running'"
#: 선점한 실행 위치. TS 멈춤 판정(draftStaleMsFor)이 'worker'면 워커 시간 상한(15분 + 60초)으로 본다.
RUNNER = "worker"
#: 선점: 'material' → 'writing'(TS runResumeDraftJob setStage claim과 같은 SQL). result에 실행 위치를 함께 남긴다.
_CLAIM = (
    "UPDATE resume_draft_jobs SET stage = %(stage)s, updated_at = %(now)s, "
    "result = (CASE WHEN jsonb_typeof(result) = 'object' THEN result ELSE '{}'::jsonb END) || jsonb_build_object('runner', 'worker') "
    f"WHERE {_MINE} AND stage = 'material'"
)


def _notify_failed(ctx: WorkerContext, user_id: str, job_id: str, label: str, error: str, regenerate: bool) -> Awaitable[None]:
    return notify(
        ctx.db,
        user_id,
        NewNotification(
            kind="resume-draft-failed",
            title="이력서를 다시 생성하지 못했습니다" if regenerate else "AI 이력서 초안을 만들지 못했습니다",
            body=f"{label} — {error}",
            link=f"/app/resumes/drafts/{job_id}",
        ),
    )


def _pending_version_of(result: Any) -> str | None:
    v = result.get("pendingVersionId") if isinstance(result, dict) else None
    return v if isinstance(v, str) and 0 < js_len(v) <= 40 else None


async def run_resume_draft(ctx: WorkerContext, job_id: str, run_id: str, deps: RunDeps | None = None) -> None:
    """백그라운드 실행. 던지지 않는다(취소 제외). 이미 끝났거나 runId가 바뀌었으면 아무것도 쓰지 않는다."""
    d = deps or RunDeps()
    row = await ctx.db.fetchone(_SELECT_MINE, {"id": job_id, "run_id": run_id})
    if row is None or not row.get("user_id"):
        return
    # 다른 실행(Vercel after())이 이미 선점했다 — 자료를 다시 읽지 않고 끝낸다.
    if row["stage"] != "material":
        return
    # 신원은 DB 작업 행에서만 읽는다(요청 본문을 믿지 않는다).
    user_id: str = row["user_id"]
    mine = {"id": job_id, "user_id": user_id, "run_id": run_id}
    label: str = row["label"]
    target: str | None = row["target_resume_id"]
    regenerate = target is not None
    claimed = False
    saved_resume_id: str | None = None
    saved_version: tuple[str, str] | None = None

    async def set_stage(stage: str, *, claim: bool = False) -> None:
        sql = _CLAIM if claim else f"UPDATE resume_draft_jobs SET stage = %(stage)s, updated_at = %(now)s WHERE {_MINE}"
        n = await ctx.db.execute(sql, {**mine, "stage": stage, "now": _dt(d.now_ms())})
        if n == 0:
            raise DraftSupersededError()

    try:
        input = parse_create_resume_input(row["input"])
        if input is None:
            raise FeatureError("초안 입력을 읽지 못했습니다. 새 이력서 화면에서 다시 만들어 주세요.", 400)
        user = await ctx.db.fetchone("SELECT id, name, email FROM users WHERE id = %s", (user_id,))
        if user is None:
            return
        # 다시 생성 대상이 그사이 지워졌으면 AI를 부르기 전에 실패로 닫는다.
        if target and await ctx.db.fetchone("SELECT id FROM company_resumes WHERE id = %s AND user_id = %s", (target, user_id)) is None:
            raise FeatureError(REGENERATE_TARGET_GONE, 404)

        material = await load_draft_material(ctx, user, input["source"], load_graph=d.load_graph)
        if material is None:
            raise FeatureError("AI 초안 출처를 찾지 못했습니다.", 400)
        # 선점: 'material' → 'writing'. Vercel after()가 같은 runId로 함께 시작했어도 한쪽만 여기를 지난다.
        await set_stage("writing", claim=True)
        claimed = True

        provider = row["provider"]
        usage = LlmUsageContext(user_id=user_id, reference_id=job_id)
        client = d.create_client(provider, usage) if d.create_client else ctx.llm.create(provider, usage)
        # 시간 상한은 작업 시작 시각부터 잰다. 남은 시간이 거의 없어도 최소 1초는 준다(상한보다 길게는 주지 않는다).
        started_ms = row["started_at"].timestamp() * 1000
        limit_ms = min(d.time_limit_ms, max(1_000, started_ms + d.time_limit_ms - d.now_ms()))
        draft_ctx = draft_context_for(user, input, material)
        try:
            draft = await asyncio.wait_for(generate_resume_draft(client, draft_ctx), timeout=limit_ms / 1000)
        except TimeoutError as err:
            raise FeatureError(DRAFT_TIMEOUT_MESSAGE, 504) from err
        await set_stage("saving")

        if target:
            prior = _pending_version_of(row["result"])
            if prior:
                await discard_regenerated_version(ctx, user_id, target, prior)
            version_id = new_id()
            marked = await ctx.db.execute(
                f"UPDATE resume_draft_jobs SET result = %(result)s, updated_at = %(now)s WHERE {_MINE}",
                # runner는 선점 때 남긴 실행 위치(TS 멈춤 판정 기준) — 덮어쓰지 않게 함께 쓴다.
                {**mine, "result": Jsonb({"pendingVersionId": version_id, "runner": RUNNER}), "now": _dt(d.now_ms())},
            )
            if marked == 0:
                raise DraftSupersededError()
            version = await save_regenerated_version(ctx, user_id, target, draft["document"], version_id=version_id, template_id=input["templateId"])
            saved_version = (target, version.id)
            if d.on_saved:
                await d.on_saved(target)
            done = await ctx.db.execute(
                f"UPDATE resume_draft_jobs SET status = 'completed', stage = 'saving', error = NULL, resume_id = %(resume_id)s, result = %(result)s, "
                f"input = NULL, completed_at = %(now)s, updated_at = %(now)s WHERE {_MINE}",
                {
                    **mine,
                    "resume_id": target,
                    "result": Jsonb(strip_nul_deep({"notes": draft["notes"], "missingInfo": draft["missingInfo"], "versionId": version.id})),
                    "now": _dt(d.now_ms()),
                },
            )
            # 멈춤 판정·다시 시도로 이 실행을 버렸다 — 아래 except가 저장한 버전을 지운다.
            if done == 0:
                raise DraftSupersededError()
            saved_version = None
            await apply_regenerated_meta(ctx, user_id, target, input)
            missing = len(draft["missingInfo"])
            await notify(
                ctx.db,
                user_id,
                NewNotification(
                    kind="resume-draft-completed",
                    title="이력서를 다시 생성했습니다",
                    body=f"{label} — 새 버전 v{version.version_no}{f' · 채워야 할 정보 {missing}개' if missing > 0 else ''}",
                    link=f"/app/resumes/{target}?regenerated=1",
                ),
            )
            return

        # 그사이 연결할 공고가 지워졌으면 공고 없이 만든다(FK 위반 방지).
        posting_id = None if input["kind"] == "general" else input.get("postingId")
        if posting_id and await ctx.db.fetchone("SELECT id FROM job_postings WHERE id = %s AND user_id = %s", (posting_id, user_id)) is None:
            posting_id = None
        resume_id, _version = await create_resume(
            ctx,
            user_id,
            kind=input.get("kind") or "company",
            company=input["company"],
            role_title=input["roleTitle"],
            jd_text=input["jdText"],
            template_id=input["templateId"],
            title=input["title"],
            document=draft["document"],
            source="ai",
            note="경험 그래프로 만든 AI 초안" if material.kind == "graph" else "진단 재작성본으로 만든 AI 초안",
            posting_id=posting_id,
        )
        saved_resume_id = resume_id
        if d.on_saved:
            await d.on_saved(resume_id)

        # 아직 이 실행이 'running'으로 소유할 때만 완료로 바꾼다.
        done = await ctx.db.execute(
            f"UPDATE resume_draft_jobs SET status = 'completed', stage = 'saving', error = NULL, resume_id = %(resume_id)s, result = %(result)s, "
            f"input = NULL, completed_at = %(now)s, updated_at = %(now)s WHERE {_MINE}",
            {**mine, "resume_id": resume_id, "result": Jsonb(strip_nul_deep({"notes": draft["notes"], "missingInfo": draft["missingInfo"]})), "now": _dt(d.now_ms())},
        )
        if done == 0:
            # 멈춤 판정·다시 시도로 이 실행을 버렸다 — 이 실행이 만든 이력서는 지운다(같은 초안이 둘 생기지 않게).
            saved_resume_id = None
            await _discard_resume(ctx, user_id, resume_id)
            return
        saved_resume_id = None
        missing = len(draft["missingInfo"])
        await notify(
            ctx.db,
            user_id,
            NewNotification(
                kind="resume-draft-completed",
                title="AI 이력서 초안이 완성됐습니다",
                body=f"{label} — 채워야 할 정보 {missing}개" if missing > 0 else label,
                link=f"/app/resumes/{resume_id}",
            ),
        )
    except asyncio.CancelledError:
        # 워커 종료(배포·재시작)로 끊겼다. 저장했는데 완료 기록 전이면 만든 이력서·버전을 지우고(다시 시도가 중복을 만들지 않게),
        # 선점한 뒤라면 실패로 닫아 사용자가 16분을 기다리지 않고 바로 다시 시도하게 한다. 선점 전이면 행을 그대로 둔다 —
        # 재시작한 워커의 스위퍼가 다시 집는다(KIND.sweep_query).
        await _cleanup_cancelled(ctx, user_id, job_id, label, regenerate, mine, claimed, saved_resume_id, saved_version, d)
        raise
    except Exception as err:  # noqa: BLE001 — 실패는 작업 행에 기록한다
        if saved_resume_id:
            await _discard_resume(ctx, user_id, saved_resume_id)
        if saved_version:
            await discard_regenerated_version(ctx, user_id, saved_version[0], saved_version[1])
        if isinstance(err, DraftSupersededError):
            return
        if not isinstance(err, (LlmPermanentError, FeatureError)):
            log.error("resume_draft_error id=%s error=%s", job_id, type(err).__name__)
        message = draft_error_message(err)
        # 선점 전 실패는 아직 아무도 선점하지 않았을 때만 기록한다(먼저 선점한 다른 실행을 덮지 않게).
        cond = _MINE if claimed else _MINE + " AND stage = 'material'"
        try:
            n = await ctx.db.execute(
                f"UPDATE resume_draft_jobs SET status = 'failed', error = %(error)s, updated_at = %(now)s WHERE {cond}",
                {**mine, "error": strip_nul(message), "now": _dt(d.now_ms())},
            )
        except Exception:  # noqa: BLE001
            n = 0
        if n > 0:
            await _notify_failed(ctx, user_id, job_id, label, message, regenerate)


async def _cleanup_cancelled(
    ctx: WorkerContext,
    user_id: str,
    job_id: str,
    label: str,
    regenerate: bool,
    mine: dict[str, str],
    claimed: bool,
    saved_resume_id: str | None,
    saved_version: tuple[str, str] | None,
    d: RunDeps,
) -> None:
    """취소 뒤 정리. 던지지 않는다(취소를 그대로 다시 던질 수 있게)."""
    try:
        if saved_resume_id:
            await _discard_resume(ctx, user_id, saved_resume_id)
        if saved_version:
            await discard_regenerated_version(ctx, user_id, saved_version[0], saved_version[1])
        if claimed:
            n = await ctx.db.execute(
                f"UPDATE resume_draft_jobs SET status = 'failed', error = %(error)s, updated_at = %(now)s WHERE {_MINE}",
                {**mine, "error": CANCELLED_MESSAGE, "now": _dt(d.now_ms())},
            )
            if n > 0:
                await _notify_failed(ctx, user_id, job_id, label, CANCELLED_MESSAGE, regenerate)
    except BaseException as err:  # noqa: BLE001 — 정리 실패는 이름만 남긴다(stale 규칙이 닫는다)
        log.error("resume_draft_cancel_cleanup_failed id=%s error=%s", job_id, type(err).__name__)


async def _discard_resume(ctx: WorkerContext, user_id: str, resume_id: str) -> None:
    try:
        await delete_resume(ctx, user_id, resume_id)
    except Exception as err:  # noqa: BLE001
        log.error("discard_resume_failed resume=%s error=%s", resume_id, type(err).__name__)


async def _run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
    await run_resume_draft(ctx, job_id, run_id)


#: 스위퍼(docs/PYTHON-WORKER.md §3.4)가 다시 집을 행. 이 표에는 'queued'가 없어(처음부터 'running') 그 대신 '아직 아무도 선점하지 않은'
#: 행(stage='material')을 본다: 디스패치 202 뒤 워커가 재시작돼 큐에서 사라졌거나, Vercel after()가 선점 전에 죽은 경우.
#: - started_at이 older_than_sec보다 오래됐고 SWEEP_MAX_AGE_SEC(=Vercel 멈춤 판정 330초보다 앞) 안인 것만 — Vercel이 실패로 닫기 전에
#:   집고, 남은 시간 상한이 충분할 때만 다시 실행한다.
#: - 다시 집어도 accept()의 precheck·엔진 확인과 실행부의 선점 UPDATE(stage='material')를 지나므로 두 번 실행되지 않는다.
SWEEP_MAX_AGE_SEC = 300
SWEEP_QUERY = (
    f"SELECT id, run_id FROM {TABLE} WHERE status = 'running' AND stage = 'material' AND provider = 'anthropic' AND run_id IS NOT NULL "
    "AND started_at < now() - make_interval(secs => %(older_than_sec)s::double precision) "
    f"AND started_at > now() - make_interval(secs => {SWEEP_MAX_AGE_SEC}) ORDER BY started_at LIMIT %(limit)s"
)

#: 실행할 수 있는 행: (id, run_id, status='running'). 이미 선점된(stage가 'material'이 아닌) 행도 받는다 — 실행부의 선점 UPDATE가 막는다.
KIND = JobKind(name=KIND_NAME, run=_run, precheck=table_precheck(TABLE, ("running",)), sweep_query=SWEEP_QUERY)
