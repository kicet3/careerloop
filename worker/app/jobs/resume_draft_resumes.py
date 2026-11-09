"""이력서 저장(초안 작업이 쓰는 부분만) — TS src/lib/resumes/service.ts(createResume·saveVersion·deleteResume·discardVersion·
getVersionDocument·updateResumeMeta)와 regenerate.ts(saveRegeneratedVersion·preserveUserFields·discardRegeneratedVersion·applyRegeneratedMeta)의 워커판.

- 메타·버전 목록은 Postgres(company_resumes·resume_versions), 버전 본문은 저장소 users/<userId>/resumes/<resumeId>/v<n>.json.
- 모든 SQL은 user_id 조건을 건다(남의 이력서는 없는 것으로 본다). 저장소 키는 DB 행에 적힌 값이라도 assert_user_key로 그 사용자 접두사인지 확인한다.
- 버전 번호 예약·포인터 이동·버전 삭제는 TS와 같은 advisory lock(hashtext('resume:<id>'))을 건 트랜잭션에서 한다 — Vercel 쪽 저장과 같은 잠금을 공유한다.
"""

from __future__ import annotations

import copy
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from psycopg import errors as pg_errors

from app.jobs.base import WorkerContext
from app.jobs.resume_draft_output import parse_resume_document, require_resume_document
from app.jsutil import js_slice, js_trim, well_formed
from app.storage import assert_user_key, user_key, user_prefix

log = logging.getLogger("worker.resume_draft")

#: TS resumes/types.ts와 같은 상한.
MAX_RESUMES_PER_USER = 100
MAX_VERSIONS_PER_RESUME = 200
GENERAL_RESUME_DEFAULT_TITLE = "공용 이력서"
DEFAULT_RESUME_APPLY_STATUS = "draft"
REGENERATE_TARGET_GONE = "다시 생성하는 동안 이력서가 삭제되어 결과를 저장하지 못했습니다."
REGENERATE_VERSION_NOTE_SINGLE = "AI 다시 생성 (빠른 초안)"
#: 기준 버전이 겹칠 때 다시 읽어 저장하는 횟수(마지막은 기준 없이).
REGENERATE_SAVE_ATTEMPTS = 3

_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
#: saveVersion의 baseVersionId를 주지 않았음(None은 '현재 버전이 없어야 함'이라 따로 둔다).
UNSET: Any = object()


class FeatureError(Exception):
    """사용자에게 보여도 되는 실패(TS FeatureError). message가 작업 행 error에 그대로 들어간다."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def new_id() -> str:
    """TS service.ts newId(영문·숫자 16자 — 저장소 키 조각으로 쓴다)."""
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(16))


def strip_nul(s: str | None) -> str | None:
    """DB·저장소에 쓸 문자열: NUL 제거(TS stripNul) + 외톨이 서로게이트 → U+FFFD(UTF-8로 쓸 수 있게 — Node와 같은 결과)."""
    return well_formed(s.replace("\u0000", "")) if isinstance(s, str) else s


def strip_nul_deep(v: Any) -> Any:
    """JSON 값 안의 모든 문자열·키에서 NUL을 지운다(TS stripNulDeep)."""
    if isinstance(v, str):
        return strip_nul(v)
    if isinstance(v, list):
        return [strip_nul_deep(x) for x in v]
    if isinstance(v, dict):
        return {strip_nul(k): strip_nul_deep(x) for k, x in v.items()}
    return v


def _now() -> datetime:
    return datetime.now(UTC)


def version_storage_key(user_id: str, resume_id: str, version_no: int) -> str:
    return user_key(user_id, "resumes", resume_id, f"v{version_no}.json")


def default_resume_title(company: str, role_title: str) -> str:
    return js_slice(js_trim(f"{company} {role_title}"), 0, 120)


async def _lock_resume(conn: Any, resume_id: str) -> None:
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s::text))", (f"resume:{resume_id}",))


async def _owned_row(ctx: WorkerContext, user_id: str, resume_id: str) -> dict[str, Any] | None:
    return await ctx.db.fetchone(
        "SELECT id, kind, current_version_id, template_id, jd_text FROM company_resumes WHERE id = %s AND user_id = %s",
        (resume_id, user_id),
    )


@dataclass(frozen=True)
class VersionMeta:
    id: str
    version_no: int


# ---------------------------------------------------------------------------
# 버전 저장(saveVersion)
# ---------------------------------------------------------------------------


async def _reserve_version(ctx: WorkerContext, user_id: str, resume_id: str, *, source: str, note: str | None, base_version_id: Any, version_id: str | None) -> dict[str, Any] | None:
    async with ctx.db.connection() as conn, conn.transaction():
        await _lock_resume(conn, resume_id)
        r = await (await conn.execute("SELECT id, current_version_id, kind FROM company_resumes WHERE id = %s AND user_id = %s", (resume_id, user_id))).fetchone()
        if r is None:
            return None
        if base_version_id is None and r["current_version_id"] is not None:
            return None
        if isinstance(base_version_id, str):
            if r["current_version_id"] != base_version_id:
                return None
            base = await (await conn.execute("SELECT version_no FROM resume_versions WHERE id = %s", (base_version_id,))).fetchone()
            if base is not None:
                newer = await (await conn.execute("SELECT count(*) AS n FROM resume_versions WHERE resume_id = %s AND version_no > %s", (resume_id, base["version_no"]))).fetchone()
                if newer["n"] > 0:
                    return None
        agg = await (await conn.execute("SELECT count(*) AS n, max(version_no) AS mx FROM resume_versions WHERE resume_id = %s", (resume_id,))).fetchone()
        if agg["n"] >= MAX_VERSIONS_PER_RESUME:
            return None
        version_no = (agg["mx"] or 0) + 1
        row = {
            "id": version_id or new_id(),
            "resume_id": resume_id,
            "version_no": version_no,
            "storage_key": version_storage_key(user_id, resume_id, version_no),
            "note": strip_nul(js_trim(note) if note else None) or None,
            "source": source,
        }
        await conn.execute(
            "INSERT INTO resume_versions (id, resume_id, version_no, storage_key, note, source, created_at) "
            "VALUES (%(id)s, %(resume_id)s, %(version_no)s, %(storage_key)s, %(note)s, %(source)s, %(created_at)s)",
            {**row, "created_at": _now()},
        )
        return {**row, "resume_kind": r["kind"]}


async def save_version(
    ctx: WorkerContext,
    user_id: str,
    resume_id: str,
    document: dict[str, Any],
    *,
    source: str,
    note: str | None = None,
    base_version_id: Any = UNSET,
    template_id: str | None = None,
    version_id: str | None = None,
) -> VersionMeta | None:
    """새 버전을 저장하고 현재 버전으로 삼는다(TS saveVersion). 남의 이력서면 None."""
    doc = require_resume_document(document)
    try:
        reserved = await _reserve_version(ctx, user_id, resume_id, source=source, note=note, base_version_id=base_version_id, version_id=version_id)
    except pg_errors.UniqueViolation as err:
        raise FeatureError("동시에 저장한 요청이 있습니다. 잠시 후 다시 저장해 주세요.", 409) from err
    if reserved is None:
        if await _owned_row(ctx, user_id, resume_id) is None:
            return None
        n = (await ctx.db.fetchone("SELECT count(*) AS n FROM resume_versions WHERE resume_id = %s", (resume_id,)) or {"n": 0})["n"]
        if base_version_id is not UNSET and n < MAX_VERSIONS_PER_RESUME:
            raise FeatureError("다른 곳에서 이 이력서를 먼저 저장했습니다. 새로고침한 뒤 다시 저장해 주세요.", 409)
        raise FeatureError(f"버전은 이력서당 {MAX_VERSIONS_PER_RESUME}개까지 저장할 수 있습니다. 새 이력서를 만들어 주세요.", 409)

    key = assert_user_key(user_id, reserved["storage_key"])
    try:
        # 지원 동기는 지원처별 이력서에만 둔다(공용 이력서로 저장하면 비운다).
        await ctx.storage.put_json(key, {**doc, "motivation": ""} if reserved["resume_kind"] == "general" else doc)
    except BaseException:
        await ctx.db.execute("DELETE FROM resume_versions WHERE id = %s", (reserved["id"],))
        raise

    # 포인터는 앞으로만 옮긴다.
    async with ctx.db.connection() as conn, conn.transaction():
        await _lock_resume(conn, resume_id)
        r = await (await conn.execute("SELECT current_version_id FROM company_resumes WHERE id = %s AND user_id = %s", (resume_id, user_id))).fetchone()
        moved = False
        if r is not None:
            cur = None
            if r["current_version_id"]:
                cur = await (await conn.execute("SELECT version_no FROM resume_versions WHERE id = %s", (r["current_version_id"],))).fetchone()
            if cur is None or cur["version_no"] < reserved["version_no"]:
                sets = "current_version_id = %(vid)s, updated_at = %(now)s" + (", template_id = %(tid)s" if template_id else "")
                res = await conn.execute(
                    f"UPDATE company_resumes SET {sets} WHERE id = %(id)s AND user_id = %(uid)s",
                    {"vid": reserved["id"], "now": _now(), "tid": template_id, "id": resume_id, "uid": user_id},
                )
                moved = res.rowcount > 0
    if not moved and base_version_id is not UNSET:
        await ctx.db.execute("DELETE FROM resume_versions WHERE id = %s", (reserved["id"],))
        try:
            await ctx.storage.delete_object(key)
        except Exception:  # noqa: BLE001
            pass
        raise FeatureError("다른 곳에서 이 이력서를 먼저 저장했습니다. 새로고침한 뒤 다시 저장해 주세요.", 409)
    return VersionMeta(reserved["id"], reserved["version_no"])


# ---------------------------------------------------------------------------
# 이력서 만들기·지우기
# ---------------------------------------------------------------------------


async def create_resume(
    ctx: WorkerContext,
    user_id: str,
    *,
    kind: str,
    company: str,
    role_title: str,
    jd_text: str | None,
    template_id: str,
    title: str | None,
    document: dict[str, Any],
    source: str,
    note: str | None,
    posting_id: str | None,
) -> tuple[str, VersionMeta]:
    """메타 + 첫 버전(v1). 본문 저장이 실패하면 메타도 지운다(TS createResume). (이력서 id, 버전)."""
    n = (await ctx.db.fetchone("SELECT count(*) AS n FROM company_resumes WHERE user_id = %s", (user_id,)) or {"n": 0})["n"]
    if n >= MAX_RESUMES_PER_USER:
        raise FeatureError(f"이력서는 {MAX_RESUMES_PER_USER}개까지 만들 수 있습니다. 쓰지 않는 이력서를 지워 주세요.", 409)
    rid = new_id()
    general = kind == "general"
    company_v = "" if general else strip_nul(js_trim(company))
    role_v = "" if general else strip_nul(js_trim(role_title))
    jd_v = None if general else strip_nul((js_trim(jd_text) if jd_text else "") or None)
    title_v = strip_nul((js_trim(title) if title else "") or None) or (GENERAL_RESUME_DEFAULT_TITLE if general else default_resume_title(company_v, role_v))
    now = _now()
    await ctx.db.execute(
        "INSERT INTO company_resumes (id, user_id, kind, company, role_title, jd_text, template_id, title, posting_id, source_resume_id, apply_status, include_photo, created_at, updated_at) "
        "VALUES (%(id)s, %(uid)s, %(kind)s, %(company)s, %(role)s, %(jd)s, %(tid)s, %(title)s, %(posting)s, NULL, %(status)s, true, %(now)s, %(now)s)",
        {
            "id": rid,
            "uid": user_id,
            "kind": kind,
            "company": company_v,
            "role": role_v,
            "jd": jd_v,
            "tid": template_id,
            "title": title_v,
            "posting": None if general else posting_id,
            "status": None if general else DEFAULT_RESUME_APPLY_STATUS,
            "now": now,
        },
    )
    try:
        version = await save_version(ctx, user_id, rid, document, source=source, note=note)
        if version is None:
            raise FeatureError("이력서를 찾을 수 없습니다.", 404)
        return rid, version
    except BaseException:
        await ctx.db.execute("DELETE FROM company_resumes WHERE id = %s AND user_id = %s", (rid, user_id))
        raise


async def delete_resume(ctx: WorkerContext, user_id: str, resume_id: str) -> bool:
    """이력서 삭제(TS deleteResume): 메타·버전 행을 먼저 지우고 저장소 객체를 지운다. 보관함 포트폴리오가 쓰는 키는 남긴다."""
    if await _owned_row(ctx, user_id, resume_id) is None:
        return False
    rows = await ctx.db.fetchall("SELECT storage_key FROM resume_versions WHERE resume_id = %s", (resume_id,))
    keys = {r["storage_key"] for r in rows}
    count = await ctx.db.execute("DELETE FROM company_resumes WHERE id = %s AND user_id = %s", (resume_id, user_id))
    if count == 0:
        return False
    try:
        keys.update(await ctx.storage.list_by_prefix(user_prefix(user_id, "resumes", resume_id)))
        in_use_rows = await ctx.db.fetchall("SELECT text_key FROM portfolios WHERE user_id = %s AND text_key = ANY(%s)", (user_id, sorted(keys)))
        in_use = {r["text_key"] for r in in_use_rows if r.get("text_key")}
        for k in sorted(keys):
            if k not in in_use:
                await ctx.storage.delete_object(assert_user_key(user_id, k))
    except Exception as err:  # noqa: BLE001 — 이력서는 이미 지워졌다(고아 객체는 같은 접두사로 다시 지울 수 있다)
        log.error("delete_resume_objects_failed resume=%s error=%s", resume_id, type(err).__name__)
    return True


async def discard_version(ctx: WorkerContext, user_id: str, resume_id: str, version_id: str) -> bool:
    """버린 버전 지우기(TS discardVersion). 현재 버전이었으면 남은 가장 새 번호로 되돌린다. 본문 객체는 잠금 안에서 지운다."""
    async with ctx.db.connection() as conn, conn.transaction():
        await _lock_resume(conn, resume_id)
        r = await (await conn.execute("SELECT current_version_id FROM company_resumes WHERE id = %s AND user_id = %s", (resume_id, user_id))).fetchone()
        if r is None:
            return False
        v = await (await conn.execute("SELECT id, storage_key FROM resume_versions WHERE id = %s AND resume_id = %s", (version_id, resume_id))).fetchone()
        if v is None:
            return False
        await conn.execute("DELETE FROM resume_versions WHERE id = %s", (v["id"],))
        if r["current_version_id"] == v["id"]:
            prev = await (await conn.execute("SELECT id FROM resume_versions WHERE resume_id = %s ORDER BY version_no DESC LIMIT 1", (resume_id,))).fetchone()
            await conn.execute(
                "UPDATE company_resumes SET current_version_id = %s WHERE id = %s AND user_id = %s",
                (prev["id"] if prev else None, resume_id, user_id),
            )
        try:
            await ctx.storage.delete_object(assert_user_key(user_id, v["storage_key"]))
        except Exception as err:  # noqa: BLE001
            log.error("discard_version_object_failed resume=%s error=%s", resume_id, type(err).__name__)
        return True


async def discard_regenerated_version(ctx: WorkerContext, user_id: str, resume_id: str, version_id: str) -> None:
    """이전 시도가 남긴 버전을 지운다. 실패해도 던지지 않는다(TS discardRegeneratedVersion)."""
    try:
        await discard_version(ctx, user_id, resume_id, version_id)
    except Exception as err:  # noqa: BLE001
        log.error("discard_regenerated_version_failed resume=%s error=%s", resume_id, type(err).__name__)


# ---------------------------------------------------------------------------
# 다시 생성(regenerate.ts)
# ---------------------------------------------------------------------------


async def _read_document(ctx: WorkerContext, user_id: str, storage_key: str) -> dict[str, Any]:
    raw = await ctx.storage.get_json(assert_user_key(user_id, storage_key))
    if raw is None:
        raise FeatureError("저장된 이력서 본문을 찾지 못했습니다. 다른 버전을 복원해 주세요.", 404)
    doc = parse_resume_document(raw, upgrade=True)
    if doc is None:
        raise FeatureError("저장된 이력서 본문 형식이 올바르지 않습니다.", 500)
    return doc


async def get_version_document(ctx: WorkerContext, user_id: str, resume_id: str, version_id: str | None) -> dict[str, Any] | None:
    """특정 버전(없으면 현재 버전) 본문(TS getVersionDocument의 document). 이력서가 남의 것이거나 버전이 없으면 None."""
    row = await _owned_row(ctx, user_id, resume_id)
    if row is None:
        return None
    wanted = version_id or row["current_version_id"]
    if wanted:
        v = await ctx.db.fetchone("SELECT id, storage_key FROM resume_versions WHERE id = %s AND resume_id = %s", (wanted, resume_id))
    else:
        v = await ctx.db.fetchone("SELECT id, storage_key FROM resume_versions WHERE resume_id = %s ORDER BY version_no DESC LIMIT 1", (resume_id,))
    if v is None:
        return None
    return await _read_document(ctx, user_id, v["storage_key"])


def _filled(v: str | None) -> bool:
    t = js_trim(v or "")
    return t != "" and not (t.startswith("[ADD:") and t.endswith("]") and "]" not in t[5:-1])


def preserve_user_fields(generated: dict[str, Any], current: dict[str, Any] | None) -> dict[str, Any]:
    """생성된 문서에 현재 버전의 사용자 칸을 덮는다(TS preserveUserFields, 순수)."""
    if current is None:
        return generated
    out = copy.deepcopy(generated)
    out["motivation"] = current["motivation"] if js_trim(current.get("motivation") or "") else (generated.get("motivation") or "")
    b, c = out["basics"], current["basics"]
    for k in ("name", "email", "phone", "portfolioUrl"):
        if _filled(c.get(k)):
            b[k] = c[k]
    if len(c["links"]) > 0:
        b["links"] = copy.deepcopy(c["links"])
    return out


async def save_regenerated_version(ctx: WorkerContext, user_id: str, resume_id: str, generated: dict[str, Any], *, version_id: str, template_id: str) -> VersionMeta:
    """다시 생성 결과를 대상 이력서의 새 버전으로 저장한다(TS saveRegeneratedVersion, mode 'single'). 이력서가 없으면 FeatureError(404)."""
    attempt = 0
    while True:
        row = await ctx.db.fetchone("SELECT current_version_id FROM company_resumes WHERE id = %s AND user_id = %s", (resume_id, user_id))
        if row is None:
            raise FeatureError(REGENERATE_TARGET_GONE, 404)
        current: dict[str, Any] | None = None
        try:
            current = await get_version_document(ctx, user_id, resume_id, row["current_version_id"])
        except FeatureError:
            # 현재 버전 본문이 저장소에서 사라졌거나 깨졌으면 보존할 값 없이 저장한다.
            current = None
        last = attempt >= REGENERATE_SAVE_ATTEMPTS - 1
        try:
            version = await save_version(
                ctx,
                user_id,
                resume_id,
                preserve_user_fields(generated, current),
                source="ai",
                note=REGENERATE_VERSION_NOTE_SINGLE,
                template_id=template_id,
                version_id=version_id,
                base_version_id=UNSET if last else row["current_version_id"],
            )
            if version is None:
                raise FeatureError(REGENERATE_TARGET_GONE, 404)
            return version
        except FeatureError as err:
            if last or err.status != 409:
                raise
        attempt += 1


async def apply_regenerated_meta(ctx: WorkerContext, user_id: str, resume_id: str, input: dict[str, Any]) -> None:
    """완료 기록 뒤: 고친 JD를 이력서 JD 칸에 반영한다(replaceJd일 때만). 실패해도 던지지 않는다(TS applyRegeneratedMeta)."""
    if input.get("kind") == "general" or not input.get("replaceJd"):
        return
    try:
        meta = await ctx.db.fetchone("SELECT jd_text FROM company_resumes WHERE id = %s AND user_id = %s", (resume_id, user_id))
        if meta is None:
            return
        nxt = js_trim(input["jdText"]) or None
        if ((js_trim(meta["jd_text"]) if meta["jd_text"] else "") or None) != nxt:
            await ctx.db.execute(
                "UPDATE company_resumes SET jd_text = %s, updated_at = %s WHERE id = %s AND user_id = %s",
                (strip_nul((js_trim(nxt) if nxt else "") or None), _now(), resume_id, user_id),
            )
    except Exception as err:  # noqa: BLE001
        log.error("apply_regenerated_meta_failed resume=%s error=%s", resume_id, type(err).__name__)
