"""AI 이력서 초안의 출력 스키마·후처리·입력 검증 — TS의 zod 스키마가 하던 일을 같은 규칙으로 옮긴 것(순수).

- ResumeDraftOutputSchema(domain/resumes.ts): document는 upgradeResumeDocument로 빠진 필드를 빈 값으로 채운 뒤 검증한다.
  zod 객체는 모르는 키를 버리므로(strip) 여기서도 스키마에 없는 키를 버리고, 키 순서를 스키마 순서로 맞춘다.
  문자열 길이(maxLength)는 zod처럼 UTF-16 길이로 잰다.
- 후처리(postprocess_draft): TS draft.ts generateResumeDraft의 LLM 호출 뒤 단계(지원 동기 비우기, 수상·기타 정리, missingInfo 질문,
  이름·메일 기본값)와 같다.
- ResumeDocumentSchema(저장 직전 검증): 초안 document 스키마 + motivation(1500자).
- CreateResumeInputSchema(resumes/types.ts): 작업 행 input(JSON)을 다시 읽을 때의 검증·기본값.
- RewriteResultSchema(domain/schemas.ts): 진단 재작성본 단계 출력 확인.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator, ValidationError, validators

from app.jobs.resume_draft_extras import extras_missing_questions, is_newcomer_document, normalize_extras
from app.jsutil import js_len, js_slice, js_trim
from app.llm.schemas import OutputSchema, raw_schema
from app.prompts.resume_draft import DraftContext, RESUME_TEMPLATE_IDS

# ---------------------------------------------------------------------------
# zod처럼 검증하는 JSON Schema 도우미
# ---------------------------------------------------------------------------


def _max_length_utf16(validator: Any, max_length: int, instance: Any, schema: dict[str, Any]) -> Any:
    if validator.is_type(instance, "string") and js_len(instance) > max_length:
        yield ValidationError(f"{instance!r} is too long")


def _min_length_utf16(validator: Any, min_length: int, instance: Any, schema: dict[str, Any]) -> Any:
    if validator.is_type(instance, "string") and js_len(instance) < min_length:
        yield ValidationError(f"{instance!r} is too short")


#: zod와 같은 문자열 길이 규칙(UTF-16)의 검증기.
ZodLikeValidator = validators.extend(Draft202012Validator, {"maxLength": _max_length_utf16, "minLength": _min_length_utf16})


def strip_unknown(value: Any, schema: dict[str, Any]) -> Any:
    """스키마에 없는 객체 키를 버리고 키를 스키마 순서로 둔다(zod 객체 파싱 결과와 같은 모양). 형식이 다르면 그대로 둔다(검증이 거절한다)."""
    t = schema.get("type")
    if t == "object" and isinstance(value, dict):
        props: dict[str, Any] = schema.get("properties") or {}
        return {k: strip_unknown(value[k], props[k]) for k in props if k in value}
    if t == "array" and isinstance(value, list) and isinstance(schema.get("items"), dict):
        return [strip_unknown(v, schema["items"]) for v in value]
    return value


def _problems(validator: Any, value: Any) -> list[str]:
    out: list[str] = []
    for err in sorted(validator.iter_errors(value), key=lambda e: list(e.absolute_path)):
        out.append(f"{'.'.join(str(p) for p in err.absolute_path) or '(root)'}: {err.message}")
        if len(out) >= 10:
            break
    return out


# ---------------------------------------------------------------------------
# 예전 저장본 보정(upgradeResumeDocument)
# ---------------------------------------------------------------------------

_EMPTY_ITEMS: dict[str, dict[str, Any]] = {
    "highlights": {"title": "", "context": ""},
    "experience": {"company": "", "department": "", "title": "", "startDate": "", "endDate": "", "location": "", "scope": "", "bullets": []},
    "projects": {
        "name": "",
        "company": "",
        "team": "",
        "role": "",
        "startDate": "",
        "endDate": "",
        "summary": "",
        "problem": "",
        "action": "",
        "result": "",
        "evidence": "",
        "bullets": [],
        "techs": [],
    },
    "skills": {"category": "", "detail": "", "items": []},
    "education": {"school": "", "degree": "", "major": "", "startDate": "", "endDate": "", "note": ""},
    "certifications": {"name": "", "issuer": "", "date": ""},
    "extras": {"title": "", "items": []},
}


def empty_resume_document() -> dict[str, Any]:
    return {
        "basics": {"name": "", "headline": "", "tagline": "", "totalExperience": "", "email": "", "phone": "", "location": "", "portfolioUrl": "", "links": []},
        "summary": "",
        "headings": {"highlights": "", "experience": "", "projects": "", "skills": "", "education": ""},
        "highlights": [],
        "experience": [],
        "projects": [],
        "skills": [],
        "education": [],
        "certifications": [],
        "extras": [],
        "motivation": "",
    }


def _with_defaults(v: Any, defaults: dict[str, Any]) -> Any:
    return {**copy.deepcopy(defaults), **v} if isinstance(v, dict) else v


def _each_with_defaults(v: Any, make: dict[str, Any]) -> Any:
    return [_with_defaults(x, make) for x in v] if isinstance(v, list) else v


def upgrade_resume_document(raw: Any) -> Any:
    """필드가 늘기 전 형식의 문서에 새 필드를 빈 값으로 채운다(TS upgradeResumeDocument). 입력을 바꾸지 않는다."""
    if not isinstance(raw, dict):
        return raw
    empty = empty_resume_document()
    out: dict[str, Any] = {**empty, **raw}
    # JS의 `raw.x ?? 기본값`: 키가 없거나 null이면 기본값.
    pick = lambda k, d: raw.get(k) if raw.get(k) is not None else d  # noqa: E731
    out["basics"] = _with_defaults(pick("basics", {}), empty["basics"])
    out["headings"] = _with_defaults(pick("headings", {}), empty["headings"])
    for k, make in _EMPTY_ITEMS.items():
        out[k] = _each_with_defaults(pick(k, []), make)
    if out.get("summary") is None:
        out["summary"] = ""
    if out.get("motivation") is None:
        out["motivation"] = ""
    return out


# ---------------------------------------------------------------------------
# 스키마
# ---------------------------------------------------------------------------

_DRAFT_RAW = raw_schema("resume_draft_output")
#: 저장용 문서 스키마(ResumeDocumentSchema): 초안 document + 지원 동기.
DOCUMENT_SCHEMA: dict[str, Any] = copy.deepcopy(_DRAFT_RAW["properties"]["document"])
DOCUMENT_SCHEMA["properties"]["motivation"] = {
    "type": "string",
    "maxLength": 1500,
    "description": "지원 동기(지원처별 이력서만, 사용자가 직접 쓴다). 없으면 빈 문자열",
}
DOCUMENT_SCHEMA["required"] = [*DOCUMENT_SCHEMA["required"], "motivation"]
_DOCUMENT_VALIDATOR = ZodLikeValidator(DOCUMENT_SCHEMA)


class DocumentInvalidError(ValueError):
    """ResumeDocumentSchema.parse 실패(TS ZodError) — 사용자에게는 일반 실패 문구로 보인다."""


def parse_resume_document(raw: Any, *, upgrade: bool) -> dict[str, Any] | None:
    """ResumeDocumentSchema(upgrade=True면 StoredResumeDocumentSchema)로 검증한 문서. 실패하면 None."""
    value = upgrade_resume_document(raw) if upgrade else raw
    stripped = strip_unknown(value, DOCUMENT_SCHEMA)
    if not isinstance(value, dict) or _problems(_DOCUMENT_VALIDATOR, stripped):
        return None
    return stripped


def require_resume_document(raw: Any) -> dict[str, Any]:
    """saveVersion의 ResumeDocumentSchema.parse(보정 없음). 실패하면 DocumentInvalidError."""
    doc = parse_resume_document(raw, upgrade=False)
    if doc is None:
        raise DocumentInvalidError("이력서 문서 형식이 올바르지 않습니다.")
    return doc


class ResumeDraftOutputSchema(OutputSchema):
    """TS ResumeDraftOutputSchema: document는 보정(upgrade) 뒤 검증, 모르는 키는 버린다. strict 스키마·schema_instruction은 생성 파일 그대로."""

    def __init__(self) -> None:
        super().__init__("resume_draft_output", _DRAFT_RAW)
        self._zod_validator = ZodLikeValidator(_DRAFT_RAW)

    def _prepare(self, value: Any) -> Any:
        if isinstance(value, dict) and "document" in value:
            value = {**value, "document": upgrade_resume_document(value["document"])}
        return strip_unknown(value, self.raw)

    def problems(self, value: Any) -> list[str]:
        return _problems(self._zod_validator, self._prepare(value))

    def parse(self, value: Any) -> tuple[bool, Any]:
        prepared = self._prepare(value)
        problems = _problems(self._zod_validator, prepared)
        if problems:
            return False, "\n".join(problems)
        return True, prepared


RESUME_DRAFT_OUTPUT_SCHEMA = ResumeDraftOutputSchema()

# ---------------------------------------------------------------------------
# 후처리(generateResumeDraft의 LLM 호출 뒤)
# ---------------------------------------------------------------------------

_ADD_ONLY = re.compile(r"^\[ADD:[^\]]*\]\Z")


def postprocess_draft(output: dict[str, Any], ctx: DraftContext) -> dict[str, Any]:
    """LLM 출력(검증된 값) → 초안(document에 지원 동기 칸 포함). 입력을 바꾸지 않는다."""
    out = copy.deepcopy(output)
    # 지원 동기는 LLM이 쓰지 않는다 — 빈 칸으로 둔다(사용자가 쓴다).
    draft = {**out, "document": {**out["document"], "motivation": ""}}
    doc = draft["document"]
    extras = normalize_extras(doc["extras"], newcomer=is_newcomer_document(doc))
    doc["extras"] = extras.extras
    if extras.dropped:
        draft["notes"] = [*draft["notes"], f"수상·기타에서 사소한 일화·소감 {len(extras.dropped)}줄을 뺐습니다."][:10]
    # new Set([...]) — 처음 나온 순서를 지키며 겹친 것을 뺀다.
    draft["missingInfo"] = list(dict.fromkeys([*draft["missingInfo"], *extras_missing_questions(doc)]))[:10]
    name = js_trim(ctx.person_name) if ctx.person_name else ""
    if not js_trim(doc["basics"]["name"]) and name:
        doc["basics"]["name"] = js_slice(name, 0, 80)
    email = js_trim(doc["basics"]["email"])
    login = js_trim(ctx.person_email) if ctx.person_email else ""
    if (not email or _ADD_ONLY.match(email)) and login:
        doc["basics"]["email"] = js_slice(login, 0, 160)
    return draft


# ---------------------------------------------------------------------------
# CreateResumeInputSchema(작업 행 input 다시 읽기)
# ---------------------------------------------------------------------------

MAX_RESUME_META_CHARS = 120
MAX_RESUME_JD_CHARS = 30_000
MAX_RESUME_EMPHASIS_CHARS = 500
_MISSING = object()


class _Invalid(Exception):
    pass


def _str(v: Any, *, trim: bool = False, min_len: int = 0, max_len: int | None = None) -> str:
    if not isinstance(v, str):
        raise _Invalid
    s = js_trim(v) if trim else v
    if js_len(s) < min_len or (max_len is not None and js_len(s) > max_len):
        raise _Invalid
    return s


def _opt(raw: dict[str, Any], key: str, fn: Any, *, default: Any = _MISSING, nullable: bool = False) -> Any:
    v = raw.get(key, _MISSING)
    if v is _MISSING:
        return default
    if v is None:
        if nullable:
            return None
        if default is not _MISSING and key not in raw:
            return default
        raise _Invalid
    return fn(v)


def _source(v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise _Invalid
    kind = v.get("kind")
    if kind in ("graph", "blank"):
        return {"kind": kind}
    if kind == "diagnosis":
        return {"kind": "diagnosis", "diagnosisId": _str(v.get("diagnosisId"), trim=True, min_len=1, max_len=64)}
    raise _Invalid


def _enum(values: tuple[str, ...]) -> Any:
    def fn(v: Any) -> str:
        if v not in values:
            raise _Invalid
        return v

    return fn


def _bool(v: Any) -> bool:
    if not isinstance(v, bool):
        raise _Invalid
    return v


def parse_create_resume_input(raw: Any) -> dict[str, Any] | None:
    """TS CreateResumeInputSchema.safeParse(row.input). 실패하면 None. 결과 키 순서·기본값은 zod 결과와 같다(없는 선택 키는 빠진다)."""
    if not isinstance(raw, dict):
        return None
    try:
        meta = lambda v: _str(v, trim=True, max_len=MAX_RESUME_META_CHARS)  # noqa: E731
        ident = lambda v: _str(v, trim=True, min_len=1, max_len=64)  # noqa: E731
        out: dict[str, Any] = {
            "kind": _opt(raw, "kind", _enum(("company", "general")), default="company"),
            "company": _opt(raw, "company", meta, default=""),
            "roleTitle": _opt(raw, "roleTitle", meta, default=""),
            "jdText": _opt(raw, "jdText", lambda v: _str(v, max_len=MAX_RESUME_JD_CHARS), default=""),
        }
        if "templateId" not in raw:
            return None
        out["templateId"] = _enum(RESUME_TEMPLATE_IDS)(raw["templateId"])
        out["title"] = _opt(raw, "title", meta, default="")
        if "source" not in raw:
            return None
        out["source"] = _source(raw["source"])
        optional: list[tuple[str, Any, bool]] = [
            ("provider", lambda v: _str(v, max_len=40), True),
            ("postingId", ident, True),
            ("sourceResumeId", ident, True),
            ("mode", _enum(("agent", "single")), False),
            ("emphasis", lambda v: _str(v, trim=True, max_len=MAX_RESUME_EMPHASIS_CHARS), False),
            ("replaceJd", _bool, False),
        ]
        for key, fn, nullable in optional:
            v = _opt(raw, key, fn, nullable=nullable)
            if v is not _MISSING:
                out[key] = v
    except _Invalid:
        return None
    if out["kind"] == "company" and (not out["company"] or not out["roleTitle"]):
        return None
    return out


# ---------------------------------------------------------------------------
# RewriteResultSchema(진단 재작성본)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RewriteResult:
    resume_markdown: str


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer())


def parse_rewrite_result(raw: Any) -> RewriteResult | None:
    """TS RewriteResultSchema.safeParse. 실패하면 None."""
    if not isinstance(raw, dict) or not isinstance(raw.get("resumeMarkdown"), str):
        return None
    changes = raw.get("changes")
    if not isinstance(changes, list):
        return None
    for c in changes:
        if not isinstance(c, dict) or "mistakeRank" not in c or "before" not in c:
            return None
        if c["mistakeRank"] is not None and not _is_int(c["mistakeRank"]):
            return None
        if c["before"] is not None and not isinstance(c["before"], str):
            return None
        if not isinstance(c.get("after"), str):
            return None
    for k in ("addQuestions", "assumptions"):
        v = raw.get(k)
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            return None
    return RewriteResult(raw["resumeMarkdown"])
