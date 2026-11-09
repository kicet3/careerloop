"""'resume-draft' 작업을 실제 Postgres(prisma/migrations 적용) + 로컬 저장소 + 가짜 LLM으로 실행한다.

WORKER_TEST_DATABASE_URL(CREATE DATABASE 권한이 있는 임시 DB 주소)이 없으면 건너뛴다. 예:
  docker run -d --rm --name wt-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55433:5432 postgres:17-alpine
  WORKER_TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:55433/postgres uv run pytest -q tests/test_resume_draft_job_pg.py
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from psycopg.types.json import Jsonb

from app.db import Database
from app.graph.service import build_career_graph
from app.jobs import resume_draft
from app.jobs.base import WorkerContext
from app.jobs.queue import JobQueue
from app.jobs.sweeper import sweep_once
from app.jobs.resume_draft import DRAFT_TIMEOUT_MESSAGE, GRAPH_DISABLED_MESSAGE, RunDeps, run_resume_draft
from app.llm.types import LlmPermanentError
from app.llm.usage import LlmUsageContext
from app.storage import Storage
from tests.fake_llm import FakeLlmClient
from tests.fakes import FakeGraph, make_settings
from tests.resume_draft_support import create_test_database, draft_handler, job_input, now, real_database_url

ADMIN_URL = real_database_url()
pytestmark = pytest.mark.skipif(ADMIN_URL is None, reason="WORKER_TEST_DATABASE_URL 없음(실제 Postgres 테스트 건너뜀)")

REWRITE = {"resumeMarkdown": "홍길동\n결제 API 응답 시간 40% 단축", "changes": [], "addQuestions": [], "assumptions": []}


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
    d = Database(db_url, min_size=1, max_size=6)
    await d.open()
    await d.execute("TRUNCATE resume_draft_jobs, resume_versions, company_resumes, notifications, diagnosis_stages, diagnoses, job_postings, llm_usage_events, users CASCADE")
    for uid, name in (("ua", "홍길동"), ("ub", None)):
        await d.execute("INSERT INTO users (id, email, name, status) VALUES (%s, %s, %s, 'approved')", (uid, f"{uid}@x.com", name))
    for did, uid in (("d1", "ua"), ("db1", "ub")):
        await d.execute(
            "INSERT INTO diagnoses (id, user_id, title, target_role, situation, resume_text, model, status) VALUES (%s, %s, '백엔드 진단', '백엔드', 'general', '원본', 'm', 'done')",
            (did, uid),
        )
        await d.execute("INSERT INTO diagnosis_stages (diagnosis_id, stage, status, output) VALUES (%s, 'rewrite', 'done', %s)", (did, Jsonb({**REWRITE, "resumeMarkdown": f"{uid} 비밀 이력서 MARK_{uid}"})))
    try:
        yield d
    finally:
        await d.close()


@pytest.fixture
def storage(tmp_path: Path) -> Storage:
    return Storage(production=False, env={"STORAGE_DIR": str(tmp_path)})


class EnabledGraph(FakeGraph):
    enabled = True


def make_ctx(db: Database, storage: Storage, graph: Any = None) -> WorkerContext:
    return WorkerContext(settings=make_settings(), db=db, llm=None, graph=graph or FakeGraph(), storage=storage)  # type: ignore[arg-type]


class Clients:
    """create_client 대신: 받은 provider·사용량 문맥을 기록하고 같은 가짜 LLM을 준다."""

    def __init__(self, llm: FakeLlmClient) -> None:
        self.llm = llm
        self.created: list[tuple[str, LlmUsageContext]] = []

    def __call__(self, provider: str, usage: LlmUsageContext) -> FakeLlmClient:
        self.created.append((provider, usage))
        return self.llm


async def insert_job(db: Database, *, jid: str = "j1", user: str = "ua", run: str = "r1", input: dict | None = None, target: str | None = None, label: str = "페이랩 · 백엔드", started_ago_sec: float = 0) -> None:
    t = now() - timedelta(seconds=started_ago_sec)
    await db.execute(
        "INSERT INTO resume_draft_jobs (id, user_id, run_id, status, stage, label, input, provider, target_resume_id, started_at, created_at, updated_at) "
        "VALUES (%s, %s, %s, 'running', 'material', %s, %s, 'anthropic', %s, %s, %s, %s)",
        (jid, user, run, label, Jsonb(input or job_input()), target, t, t, t),
    )


async def job(db: Database, jid: str = "j1") -> dict[str, Any]:
    row = await db.fetchone("SELECT * FROM resume_draft_jobs WHERE id = %s", (jid,))
    assert row is not None
    return row


async def notes(db: Database, uid: str = "ua") -> list[dict[str, Any]]:
    return await db.fetchall("SELECT kind, title, body, link FROM notifications WHERE user_id = %s ORDER BY created_at", (uid,))


# ---------------------------------------------------------------------------


async def test_success_creates_resume_and_completes(db: Database, storage: Storage) -> None:
    await insert_job(db)
    clients = Clients(FakeLlmClient({"resume-draft": draft_handler}))
    stages: list[str] = []
    orig = clients.llm.generate

    async def generate(req: Any) -> Any:
        stages.append((await job(db))["stage"])
        return await orig(req)

    clients.llm.generate = generate  # type: ignore[method-assign]
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=clients))

    row = await job(db)
    assert row["status"] == "completed" and row["stage"] == "saving" and row["error"] is None
    assert row["input"] is None and row["completed_at"] is not None
    assert stages == ["writing"]
    assert row["result"]["missingInfo"][0] == "Kafka 경험이 있는지"
    assert any("사소한 일화" in n for n in row["result"]["notes"])
    # 신원·사용량은 DB 작업 행의 user_id.
    assert clients.created == [("anthropic", LlmUsageContext(user_id="ua", reference_id="j1"))]
    # 프롬프트에는 내 진단 재작성본만(남의 것은 없다).
    prompt = clients.llm.calls[0].user
    assert "MARK_ua" in prompt and "MARK_ub" not in prompt
    resume = await db.fetchone("SELECT * FROM company_resumes WHERE id = %s", (row["resume_id"],))
    assert resume["user_id"] == "ua" and resume["company"] == "페이랩" and resume["role_title"] == "백엔드"
    assert resume["title"] == "페이랩 백엔드" and resume["apply_status"] == "draft" and resume["jd_text"] == "Kotlin 경험자"
    versions = await db.fetchall("SELECT * FROM resume_versions WHERE resume_id = %s", (resume["id"],))
    assert len(versions) == 1 and versions[0]["source"] == "ai" and versions[0]["version_no"] == 1
    assert versions[0]["note"] == "진단 재작성본으로 만든 AI 초안" and resume["current_version_id"] == versions[0]["id"]
    assert versions[0]["storage_key"] == f"users/ua/resumes/{resume['id']}/v1.json"
    doc = await storage.get_json(versions[0]["storage_key"])
    assert doc["motivation"] == "" and doc["basics"]["name"] == "홍길동" and doc["basics"]["email"] == "ua@x.com"
    assert list(doc)[-1] == "motivation"
    assert await notes(db) == [{"kind": "resume-draft-completed", "title": "AI 이력서 초안이 완성됐습니다", "body": "페이랩 · 백엔드 — 채워야 할 정보 2개", "link": f"/app/resumes/{resume['id']}"}]
    assert await notes(db, "ub") == []


async def test_llm_failure_writes_korean_message_and_notifies(db: Database, storage: Storage) -> None:
    await insert_job(db)
    llm = FakeLlmClient(errors={"resume-draft": LlmPermanentError("거절", "refusal")})
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm)))
    row = await job(db)
    msg = "초안을 만들지 못했습니다. AI 모델이 응답을 거절했습니다. 이력서·공고 내용을 확인한 뒤 다시 시도해 주세요."
    assert row["status"] == "failed" and row["error"] == msg and row["stage"] == "writing"
    assert row["input"] is not None  # 다시 시도할 수 있게 남긴다
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 0
    assert await notes(db) == [{"kind": "resume-draft-failed", "title": "AI 이력서 초안을 만들지 못했습니다", "body": f"페이랩 · 백엔드 — {msg}", "link": "/app/resumes/drafts/j1"}]


async def test_guard_two_concurrent_runs_only_one_writes(db: Database, storage: Storage) -> None:
    await insert_job(db)
    llm = FakeLlmClient({"resume-draft": draft_handler}, delay_sec=0.2)
    ctx = make_ctx(db, storage)
    await asyncio.gather(*(run_resume_draft(ctx, "j1", "r1", RunDeps(create_client=Clients(llm))) for _ in range(3)))
    assert len(llm.calls) == 1
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 1
    assert (await job(db))["status"] == "completed"
    assert [n["kind"] for n in await notes(db)] == ["resume-draft-completed"]


async def test_guard_already_claimed_by_vercel_does_nothing(db: Database, storage: Storage) -> None:
    await insert_job(db)
    await db.execute("UPDATE resume_draft_jobs SET stage = 'writing' WHERE id = 'j1'")
    llm = FakeLlmClient({"resume-draft": draft_handler})
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm)))
    assert llm.calls == []
    row = await job(db)
    assert row["status"] == "running" and row["stage"] == "writing"


async def test_guard_loser_failure_does_not_override_winner(db: Database, storage: Storage) -> None:
    """선점 전 실패(자료 읽기 실패)는 그사이 다른 실행이 선점했으면 기록하지 않는다."""
    await insert_job(db, input=job_input(source={"kind": "graph"}))

    async def load_graph(graph: Any, user_id: str, name: str | None) -> Any:
        await db.execute("UPDATE resume_draft_jobs SET stage = 'writing' WHERE id = 'j1'")  # 다른 실행이 선점
        raise RuntimeError("neo4j hiccup")

    await run_resume_draft(make_ctx(db, storage, EnabledGraph()), "j1", "r1", RunDeps(load_graph=load_graph, create_client=Clients(FakeLlmClient())))
    row = await job(db)
    assert row["status"] == "running" and row["error"] is None
    assert await notes(db) == []


async def test_wrong_run_or_finished_job_is_ignored(db: Database, storage: Storage) -> None:
    await insert_job(db)
    llm = FakeLlmClient({"resume-draft": draft_handler})
    await run_resume_draft(make_ctx(db, storage), "j1", "other-run", RunDeps(create_client=Clients(llm)))
    await db.execute("UPDATE resume_draft_jobs SET status = 'failed', error = '끊김' WHERE id = 'j1'")
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm)))
    assert llm.calls == []
    assert (await job(db))["error"] == "끊김"


async def test_superseded_during_llm_discards_result(db: Database, storage: Storage) -> None:
    await insert_job(db)

    llm = FakeLlmClient({"resume-draft": draft_handler})
    orig = llm.generate

    async def generate(req: Any) -> Any:
        await db.execute("UPDATE resume_draft_jobs SET status = 'failed', error = '끊김', stage = 'saving' WHERE id = 'j1'")
        return await orig(req)

    llm.generate = generate  # type: ignore[method-assign]
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm)))
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 0
    assert (await job(db))["status"] == "failed"
    assert await notes(db) == []


async def test_run_id_changed_after_save_deletes_resume(db: Database, storage: Storage, tmp_path: Path) -> None:
    await insert_job(db)

    async def on_saved(resume_id: str) -> None:
        assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 1
        await db.execute("UPDATE resume_draft_jobs SET run_id = 'other-run' WHERE id = 'j1'")

    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(FakeLlmClient({"resume-draft": draft_handler})), on_saved=on_saved))
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 0
    assert not list(tmp_path.rglob("*.json"))
    row = await job(db)
    assert row["status"] == "running" and row["run_id"] == "other-run" and row["resume_id"] is None
    assert await notes(db) == []


async def test_failure_after_save_deletes_resume_and_fails(db: Database, storage: Storage) -> None:
    await insert_job(db)

    async def on_saved(resume_id: str) -> None:
        raise ConnectionError("db down")

    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(FakeLlmClient({"resume-draft": draft_handler})), on_saved=on_saved))
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 0
    row = await job(db)
    assert row["status"] == "failed" and row["error"] == "초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
    assert [n["kind"] for n in await notes(db)] == ["resume-draft-failed"]


async def test_timeout_measured_from_started_at(db: Database, storage: Storage) -> None:
    await insert_job(db, started_ago_sec=59.9)
    llm = FakeLlmClient({"resume-draft": draft_handler}, delay_sec=1.3)
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm), time_limit_ms=60_000))
    row = await job(db)
    assert row["status"] == "failed" and row["error"] == DRAFT_TIMEOUT_MESSAGE


async def test_other_users_diagnosis_is_not_found(db: Database, storage: Storage) -> None:
    await insert_job(db, input=job_input(source={"kind": "diagnosis", "diagnosisId": "db1"}))
    llm = FakeLlmClient({"resume-draft": draft_handler})
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm)))
    row = await job(db)
    assert row["status"] == "failed" and row["error"] == "진단을 찾을 수 없습니다."
    assert llm.calls == []


async def test_graph_source_rules(db: Database, storage: Storage) -> None:
    await insert_job(db, input=job_input(source={"kind": "graph"}))
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(FakeLlmClient())))
    assert (await job(db))["error"] == GRAPH_DISABLED_MESSAGE

    # 다른 사용자의 그래프가 오면(버그) 실패한다 — 프롬프트에 넣지 않는다.
    await insert_job(db, jid="j2", input=job_input(source={"kind": "graph"}))
    other = build_career_graph("ub", [{"id": "n1", "label": "Company", "props": {"userId": "ub", "name": "MARK_ub"}}], [])
    llm = FakeLlmClient({"resume-draft": draft_handler})

    async def leak(graph: Any, user_id: str, name: str | None) -> Any:
        return other

    await run_resume_draft(make_ctx(db, storage, EnabledGraph()), "j2", "r1", RunDeps(load_graph=leak, create_client=Clients(llm)))
    assert (await job(db, "j2"))["status"] == "failed" and llm.calls == []

    await insert_job(db, jid="j3", input=job_input(source={"kind": "graph"}))
    mine = build_career_graph("ua", [{"id": "n1", "label": "Company", "props": {"userId": "ua", "name": "MARK_graph_ua"}}], [], "홍길동")
    seen: list[tuple[str, str | None]] = []

    async def load(graph: Any, user_id: str, name: str | None) -> Any:
        seen.append((user_id, name))
        return mine

    await run_resume_draft(make_ctx(db, storage, EnabledGraph()), "j3", "r1", RunDeps(load_graph=load, create_client=Clients(llm)))
    assert seen == [("ua", "홍길동")]
    assert (await job(db, "j3"))["status"] == "completed"
    assert "MARK_graph_ua" in llm.calls[-1].user and "<career_graph>" in llm.calls[-1].user
    v = await db.fetchone("SELECT v.note FROM resume_versions v JOIN company_resumes r ON r.id = v.resume_id WHERE r.id = (SELECT resume_id FROM resume_draft_jobs WHERE id = 'j3')")
    assert v["note"] == "경험 그래프로 만든 AI 초안"


async def test_other_users_posting_is_dropped(db: Database, storage: Storage) -> None:
    await db.execute("INSERT INTO job_postings (id, user_id, company, role_title) VALUES ('pb', 'ub', 'x', 'y')")
    await insert_job(db, input=job_input(postingId="pb"))
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(FakeLlmClient({"resume-draft": draft_handler}))))
    row = await job(db)
    assert row["status"] == "completed"
    assert (await db.fetchone("SELECT posting_id FROM company_resumes WHERE id = %s", (row["resume_id"],)))["posting_id"] is None


async def test_regenerate_saves_new_version_preserving_user_fields(db: Database, storage: Storage) -> None:
    from app.jobs.resume_draft_output import empty_resume_document

    await db.execute(
        "INSERT INTO company_resumes (id, user_id, kind, company, role_title, jd_text, template_id, title, apply_status) VALUES ('R1', 'ua', 'company', '페이랩', '백엔드', '옛 JD', 'classic', '내 이력서', 'draft')"
    )
    cur = empty_resume_document()
    cur["motivation"] = "직접 쓴 지원 동기"
    cur["basics"].update({"phone": "010-1234-5678", "email": "[ADD: 메일]"})
    await storage.put_json("users/ua/resumes/R1/v1.json", cur)
    await db.execute("INSERT INTO resume_versions (id, resume_id, version_no, storage_key, source) VALUES ('V1', 'R1', 1, 'users/ua/resumes/R1/v1.json', 'manual')")
    await db.execute("UPDATE company_resumes SET current_version_id = 'V1' WHERE id = 'R1'")
    # 이전 시도가 남긴 버전(pendingVersionId)은 먼저 지운다.
    await storage.put_json("users/ua/resumes/R1/v2.json", cur)
    await db.execute("INSERT INTO resume_versions (id, resume_id, version_no, storage_key, source) VALUES ('OLD', 'R1', 2, 'users/ua/resumes/R1/v2.json', 'ai')")
    inp = job_input(source={"kind": "graph"}, templateId="performance", jdText="새 JD", replaceJd=True, emphasis="결제", title="내 이력서", mode="single")
    await insert_job(db, input=inp, target="R1", label="다시 생성 · 내 이력서")
    await db.execute("UPDATE resume_draft_jobs SET result = %s WHERE id = 'j1'", (Jsonb({"pendingVersionId": "OLD"}),))
    mine = build_career_graph("ua", [{"id": "n1", "label": "Company", "props": {"userId": "ua", "name": "페이랩"}}], [])

    async def load(graph: Any, user_id: str, name: str | None) -> Any:
        return mine

    llm = FakeLlmClient({"resume-draft": draft_handler})
    await run_resume_draft(make_ctx(db, storage, EnabledGraph()), "j1", "r1", RunDeps(load_graph=load, create_client=Clients(llm)))
    row = await job(db)
    assert row["status"] == "completed" and row["resume_id"] == "R1" and row["input"] is None
    versions = await db.fetchall("SELECT id, version_no, note, source, storage_key FROM resume_versions WHERE resume_id = 'R1' ORDER BY version_no")
    assert [v["id"] for v in versions][0] == "V1" and "OLD" not in [v["id"] for v in versions]
    new = versions[-1]
    assert new["version_no"] == 2 and new["note"] == "AI 다시 생성 (빠른 초안)" and new["source"] == "ai"
    assert row["result"]["versionId"] == new["id"]
    resume = await db.fetchone("SELECT * FROM company_resumes WHERE id = 'R1'")
    assert resume["current_version_id"] == new["id"] and resume["template_id"] == "performance" and resume["jd_text"] == "새 JD"
    doc = await storage.get_json(new["storage_key"])
    assert doc["motivation"] == "직접 쓴 지원 동기" and doc["basics"]["phone"] == "010-1234-5678"
    assert doc["basics"]["email"] == "ua@x.com"  # 현재 값이 자리표시면 생성된 값(로그인 메일)
    assert "결제" in llm.calls[0].user and "사용자가 강조해 달라는 점" in llm.calls[0].user
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 1
    assert await notes(db) == [
        {"kind": "resume-draft-completed", "title": "이력서를 다시 생성했습니다", "body": "다시 생성 · 내 이력서 — 새 버전 v2 · 채워야 할 정보 2개", "link": "/app/resumes/R1?regenerated=1"}
    ]


async def test_regenerate_target_gone(db: Database, storage: Storage) -> None:
    await insert_job(db, input=job_input(source={"kind": "graph"}), target="GONE")
    llm = FakeLlmClient({"resume-draft": draft_handler})
    await run_resume_draft(make_ctx(db, storage, EnabledGraph()), "j1", "r1", RunDeps(create_client=Clients(llm)))
    row = await job(db)
    assert row["status"] == "failed" and row["error"] == "다시 생성하는 동안 이력서가 삭제되어 결과를 저장하지 못했습니다."
    assert llm.calls == []
    assert [(n["kind"], n["title"]) for n in await notes(db)] == [("resume-draft-failed", "이력서를 다시 생성하지 못했습니다")]


async def test_bad_input_fails(db: Database, storage: Storage) -> None:
    await insert_job(db, input={"company": "x"})
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(FakeLlmClient())))
    assert (await job(db))["error"] == "초안 입력을 읽지 못했습니다. 새 이력서 화면에서 다시 만들어 주세요."


async def test_queue_precheck_reads_row(db: Database, storage: Storage) -> None:
    await insert_job(db)
    await insert_job(db, jid="j2", user="ub")
    await db.execute("UPDATE resume_draft_jobs SET provider = 'claude-cli' WHERE id = 'j2'")
    q = JobQueue(make_ctx(db, storage), {"resume-draft": resume_draft.KIND}, concurrency=1, backlog=8)
    assert await q.accept("resume-draft", "j1", "r1") == "queued"
    assert await q.accept("resume-draft", "j1", "r1") == "duplicate"
    assert await q.accept("resume-draft", "j1", "nope") == "not_found"
    assert await q.accept("resume-draft", "j2", "r1") == "unsupported_provider"
    assert resume_draft.KIND.sweep_query == resume_draft.SWEEP_QUERY


async def test_claim_marks_runner_worker(db: Database, storage: Storage) -> None:
    """선점하면 result.runner='worker'(TS 멈춤 판정이 워커 시간 상한을 쓰는 기준). 실패로 끝나도 남는다."""
    await insert_job(db)
    llm = FakeLlmClient(errors={"resume-draft": LlmPermanentError("거절", "refusal")})
    await run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(llm)))
    assert (await job(db))["result"] == {"runner": "worker"}


async def test_sweeper_repicks_unclaimed_material_rows_only(db: Database, storage: Storage) -> None:
    """디스패치 202 뒤 워커가 재시작돼 큐에서 사라진 작업(stage='material', 아무도 선점 안 함)을 스위퍼가 다시 집는다."""
    await insert_job(db, jid="lost", started_ago_sec=150)
    await insert_job(db, jid="fresh", started_ago_sec=5)  # 아직 디스패치 중일 수 있다
    await insert_job(db, jid="claimed", started_ago_sec=150)
    await db.execute("UPDATE resume_draft_jobs SET stage = 'writing' WHERE id = 'claimed'")
    await insert_job(db, jid="tooold", started_ago_sec=400)  # Vercel 멈춤 판정(330초)이 닫을 것
    await insert_job(db, jid="cli", started_ago_sec=150)
    await db.execute("UPDATE resume_draft_jobs SET provider = 'claude-cli' WHERE id = 'cli'")
    rows = await db.fetchall(resume_draft.SWEEP_QUERY, {"older_than_sec": 120, "limit": 20})
    assert [r["id"] for r in rows] == ["lost"]

    ran: list[str] = []

    async def run(ctx: WorkerContext, job_id: str, run_id: str) -> None:
        ran.append(job_id)

    kind = resume_draft.JobKind(name="resume-draft", run=run, precheck=resume_draft.KIND.precheck, sweep_query=resume_draft.SWEEP_QUERY)
    q = JobQueue(make_ctx(db, storage), {"resume-draft": kind}, concurrency=1)
    await q.start()
    assert await sweep_once(q, older_than_sec=120) == 1
    await q.join()
    await q.stop()
    assert ran == ["lost"]


async def test_cancel_after_save_discards_resume_and_fails(db: Database, storage: Storage) -> None:
    """워커 종료(취소)가 저장 뒤·완료 기록 전에 오면 만든 이력서를 지우고 실패로 닫는다(다시 시도가 중복을 만들지 않게)."""
    await insert_job(db)
    saved = asyncio.Event()
    block = asyncio.Event()

    async def on_saved(resume_id: str) -> None:
        saved.set()
        await block.wait()  # 여기서 취소된다

    task = asyncio.create_task(
        run_resume_draft(make_ctx(db, storage), "j1", "r1", RunDeps(create_client=Clients(FakeLlmClient({"resume-draft": draft_handler})), on_saved=on_saved))
    )
    await asyncio.wait_for(saved.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await db.fetchone("SELECT count(*) AS n FROM company_resumes"))["n"] == 0
    row = await job(db)
    assert row["status"] == "failed" and row["error"] == resume_draft.CANCELLED_MESSAGE
    assert [n["kind"] for n in await notes(db)] == ["resume-draft-failed"]


async def test_cancel_before_claim_leaves_row_for_sweeper(db: Database, storage: Storage) -> None:
    await insert_job(db, input=job_input(source={"kind": "graph"}))
    started = asyncio.Event()

    async def load_graph(graph: Any, user_id: str, name: str | None) -> Any:
        started.set()
        await asyncio.sleep(10)

    task = asyncio.create_task(run_resume_draft(make_ctx(db, storage, EnabledGraph()), "j1", "r1", RunDeps(load_graph=load_graph, create_client=Clients(FakeLlmClient()))))
    await asyncio.wait_for(started.wait(), 5)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    row = await job(db)
    assert row["status"] == "running" and row["stage"] == "material" and row["error"] is None
