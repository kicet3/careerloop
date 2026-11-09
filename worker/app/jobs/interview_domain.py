"""면접 연습 계약·순수 함수 — TS src/lib/domain/interview.ts, src/lib/interview/source.ts(verifyCitations·normalizeGeneratedQuestions·sourceLinesToPrompt),
src/lib/interview/service.ts(toInterviewFeedback·lengthScore·interviewErrorMessage)의 워커판.

- 문자열 길이·자르기는 JS와 같게 UTF-16 코드 단위로 한다(app.jsutil). 공백(\\s)·trim도 JS 규칙이다.
- 스냅숏(users/<userId>/interview/<sessionId>/source.json)은 TS InterviewSourceSnapshotSchema와 같은 규칙으로 확인한다(parse_source_snapshot).
- 같은 입력에 TS와 같은 출력이 나오는지는 tests/fixtures/prompts/interview_postprocess.json(TS가 만든 기대값)으로 확인한다.
"""

from __future__ import annotations

import math
import re
from typing import Any

from app.jsutil import JS_WS_CLASS, js_collapse_ws, js_len, js_slice, js_trim
from app.llm.pricing import js_round
from app.llm.types import LlmPermanentError

# ---------------------------------------------------------------------------
# 분류·라벨·한도 (TS src/lib/domain/interview.ts)
# ---------------------------------------------------------------------------

INTERVIEW_QUESTION_CATEGORIES = ("line", "project", "pivot", "tough", "motivation", "job")
INTERVIEW_CATEGORY_LABELS: dict[str, str] = {
    "line": "서류 한 줄 질문",
    "project": "대표 프로젝트 5단계",
    "pivot": "빈틈 확인(PIVOT)",
    "tough": "곤란한 질문",
    "motivation": "지원 동기·이직 사유",
    "job": "직무 일반",
}

LINE_FACETS = ("why", "goal", "cause", "alternative", "ownership", "conflict", "measure", "confound", "failure", "transfer")
PROJECT_FACETS = ("background", "goal", "problem", "process", "result")
PIVOT_FACETS = ("P", "I", "V", "O", "T")
TOUGH_FACETS = ("number", "team", "failure", "unfamiliar", "counter")
MOTIVATION_FACETS = ("motivation", "change", "intro")

INTERVIEW_FACETS: dict[str, tuple[str, ...]] = {
    "line": LINE_FACETS,
    "project": PROJECT_FACETS,
    "pivot": PIVOT_FACETS,
    "tough": TOUGH_FACETS,
    "motivation": MOTIVATION_FACETS,
    "job": (),
}

INTERVIEW_FACET_LABELS: dict[str, str] = {
    "why": "필요성",
    "goal": "목표·지표",
    "cause": "원인 확인",
    "alternative": "대안 비교",
    "ownership": "본인 역할",
    "conflict": "합의 기준",
    "measure": "측정 방법",
    "confound": "다른 요인",
    "failure": "실패·미해결",
    "transfer": "지원팀 적용",
    "background": "배경",
    "problem": "문제 정의",
    "process": "과정",
    "result": "결과와 회고",
    "P": "P · 왜 문제인가",
    "I": "I · 왜 그 지표인가",
    "V": "V · 왜 그 대안인가",
    "O": "O · 어디까지 본인이 했나",
    "T": "T · 다른 팀에서 적용",
    "number": "숫자가 기억나지 않을 때",
    "team": "팀 성과 속 내 몫",
    "unfamiliar": "해 보지 않은 일",
    "counter": "다른 원인 제시",
    "motivation": "지원 동기",
    "change": "이직 사유",
    "intro": "자기소개",
}


class INTERVIEW_LIMITS:  # noqa: N801 — TS 상수 이름 그대로
    questionsPerSession = 40
    sessionsPerUser = 50
    answersPerQuestion = 20
    answerChars = 3000
    questionChars = 400
    intentChars = 300
    followUpChars = 300
    followUpsPerQuestion = 3
    citationsPerQuestion = 3
    quoteChars = 300
    titleChars = 120
    lineChars = 600
    portfolioPromptChars = 12_000
    jdPromptChars = 8_000
    durationSec = 600


KOREAN_SPOKEN_CHARS_PER_SEC = 5

RECOMMENDED_ANSWER_SECONDS: dict[str, dict[str, int]] = {
    "line": {"min": 30, "max": 90},
    "project": {"min": 45, "max": 120},
    "pivot": {"min": 30, "max": 90},
    "tough": {"min": 30, "max": 90},
    "motivation": {"min": 30, "max": 90},
    "job": {"min": 30, "max": 90},
}

INTERVIEW_CRITERIA = ("evidence", "numbers", "ownership", "length", "structure")
INTERVIEW_SOURCE_DOCS = ("resume", "portfolio", "posting")
PORTFOLIO_KINDS = ("file", "url", "graph")

_WS_RUN = re.compile(f"{JS_WS_CLASS}+")


def remove_ws(s: str) -> str:
    """s.replace(/\\s+/g, "")"""
    return _WS_RUN.sub("", s)


def estimate_spoken_seconds(text: str) -> int:
    """TS estimateSpokenSeconds: 공백 뺀 글자 수(UTF-16) / 5, Math.round."""
    return js_round(js_len(remove_ws(text)) / KOREAN_SPOKEN_CHARS_PER_SEC)


def normalize_facet(category: str, facet: str | None) -> str | None:
    if not facet:
        return None
    return facet if facet in INTERVIEW_FACETS.get(category, ()) else None


# ---------------------------------------------------------------------------
# 문자열 도우미
# ---------------------------------------------------------------------------


def clean(s: str) -> str:
    """s.replace(/\\s+/g, " ").trim()"""
    return js_trim(js_collapse_ws(s))


def clip(s: str, n: int) -> str:
    """s.length > n ? s.slice(0, n - 1) + "…" : s (UTF-16)."""
    return f"{js_slice(s, 0, n - 1)}…" if js_len(s) > n else s


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def well_formed(s: str) -> str:
    """외톨이 서로게이트(JS slice가 이모지를 가를 때 생긴다)를 U+FFFD로. Node가 UTF-8로 보낼 때와 같은 결과이고,
    Python은 그대로 두면 UTF-8 인코딩(DB·HTTP)에서 실패한다."""
    return _LONE_SURROGATE.sub("\ufffd", s)


def strip_nul(s: str | None) -> str | None:
    """DB에 쓸 문자열: NUL 제거(TS stripNul) + 외톨이 서로게이트 → U+FFFD."""
    if not isinstance(s, str):
        return s
    return well_formed(s.replace("\u0000", "") if "\u0000" in s else s)


def strip_nul_deep(value: Any) -> Any:
    """TS stripNulDeep: JSON 값 안의 모든 문자열·키에서 NUL을 지운다."""
    if isinstance(value, str):
        return strip_nul(value)
    if isinstance(value, list):
        return [strip_nul_deep(v) for v in value]
    if isinstance(value, dict):
        return {strip_nul(k): strip_nul_deep(v) for k, v in value.items()}
    return value


# ---------------------------------------------------------------------------
# 스냅숏 확인 (TS InterviewSourceSnapshotSchema.safeParse)
# ---------------------------------------------------------------------------

_LINE_ID_RE = re.compile(r"^[rpj][0-9]{1,4}\Z")


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v: Any) -> bool:
    return _is_num(v) and float(v).is_integer() and abs(v) <= 9007199254740991


def _opt_str(v: Any) -> bool:
    return v is None or isinstance(v, str)


def _parse_line(v: Any) -> dict[str, Any] | None:
    if not isinstance(v, dict):
        return None
    i, doc, label, path, text = v.get("id"), v.get("doc"), v.get("label"), v.get("path", ...), v.get("text")
    if not _is_str(i) or not _LINE_ID_RE.match(i):
        return None
    if doc not in INTERVIEW_SOURCE_DOCS or not _is_str(label) or js_len(label) > 200:
        return None
    if path is ... or not _opt_str(path) or (path is not None and js_len(path) > 120):
        return None
    if not _is_str(text) or js_len(text) > INTERVIEW_LIMITS.lineChars:
        return None
    return {"id": i, "doc": doc, "label": label, "path": path, "text": text}


def parse_source_snapshot(raw: Any) -> dict[str, Any] | None:
    """스냅숏 JSON → 확인된 값(알 수 없는 키는 버린다 — zod object 기본). 형식이 틀리면 None."""
    if not isinstance(raw, dict) or raw.get("version") != 1 or isinstance(raw.get("version"), bool):
        return None
    r = raw.get("resume")
    if not isinstance(r, dict):
        return None
    if not all(_is_str(r.get(k)) for k in ("id", "title", "company", "roleTitle")) or r.get("kind") not in ("company", "general"):
        return None
    if "versionId" not in r or not _opt_str(r.get("versionId")):
        return None
    vno = r.get("versionNo", ...)
    if vno is ... or not (vno is None or _is_int(vno)):
        return None
    resume = {k: r[k] for k in ("id", "title", "kind", "company", "roleTitle", "versionId", "versionNo")}

    if "posting" not in raw:
        return None
    p = raw["posting"]
    posting: dict[str, Any] | None
    if p is None:
        posting = None
    elif isinstance(p, dict) and all(_is_str(p.get(k)) for k in ("id", "company", "roleTitle", "url")):
        posting = {k: p[k] for k in ("id", "company", "roleTitle", "url")}
    else:
        return None

    if "portfolio" not in raw:
        return None
    pf = raw["portfolio"]
    portfolio: dict[str, Any] | None
    if pf is None:
        portfolio = None
    elif (
        isinstance(pf, dict)
        and pf.get("kind") in PORTFOLIO_KINDS
        and "fileName" in pf
        and _opt_str(pf.get("fileName"))
        and "url" in pf
        and _opt_str(pf.get("url"))
        and isinstance(pf.get("truncated"), bool)
    ):
        portfolio = {k: pf[k] for k in ("kind", "fileName", "url", "truncated")}
    else:
        return None

    raw_lines = raw.get("lines")
    if not isinstance(raw_lines, list) or len(raw_lines) > 1500:
        return None
    lines: list[dict[str, Any]] = []
    for x in raw_lines:
        line = _parse_line(x)
        if line is None:
            return None
        lines.append(line)
    if not _is_num(raw.get("createdAt")):
        return None
    return {"version": 1, "resume": resume, "posting": posting, "portfolio": portfolio, "lines": lines, "createdAt": raw["createdAt"]}


# ---------------------------------------------------------------------------
# 근거 줄·인용 (TS src/lib/interview/source.ts)
# ---------------------------------------------------------------------------

_PARENS = re.compile(r"[()]")
_SQUASH = re.compile(f"(?:{JS_WS_CLASS}|[\"'“”‘’`.,·…])+")
_REF_BRACKETS = re.compile(r"^\[|\]\Z")


def source_lines_to_prompt(lines: list[dict[str, Any]]) -> str:
    """`[r1] (경력 · 토스 · 기여 1) 본문` 한 줄씩."""
    return "\n".join(f"[{l['id']}] ({_PARENS.sub('', l['label'])}) {l['text']}" for l in lines)


def squash(s: str) -> str:
    return _SQUASH.sub("", s).lower()


def strip_ref(ref: str) -> str:
    """ref.trim().replace(/^\\[|\\]$/g, "")"""
    return _REF_BRACKETS.sub("", js_trim(ref))


def verify_citations(raw: list[dict[str, Any]], lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """LLM 인용 → 저장 형태. 모르는 ref는 버리고, quote가 그 줄에 (공백·문장부호 무시하고) 있으면 verified. 같은 ref는 한 번만."""
    by_id = {l["id"]: l for l in lines}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for c in raw:
        ref = strip_ref(c["ref"])
        line = by_id.get(ref)
        if line is None or ref in seen:
            continue
        seen.add(ref)
        quote = clip(clean(c["quote"]), INTERVIEW_LIMITS.quoteChars)
        q = squash(quote)
        if not q:
            out.append({"ref": ref, "doc": line["doc"], "quote": clip(line["text"], INTERVIEW_LIMITS.quoteChars), "verified": True})
        else:
            out.append({"ref": ref, "doc": line["doc"], "quote": quote, "verified": q in squash(line["text"])})
        if len(out) >= INTERVIEW_LIMITS.citationsPerQuestion:
            break
    return out


_NEEDS_CITATION = {"line", "project", "pivot", "tough"}


def normalize_generated_questions(output: dict[str, Any], lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """TS normalizeGeneratedQuestions: 빈·중복 질문 제거, facet 정규화, 인용 검증, 길이 자르기, 근거 필요한 분류는 확인된 이력서·포트폴리오 인용 필수."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for q in output["questions"]:
        if q["category"] not in INTERVIEW_QUESTION_CATEGORIES:
            continue
        question = clip(clean(q["question"]), INTERVIEW_LIMITS.questionChars)
        key = squash(question)
        if not question or key in seen:
            continue
        verified = verify_citations(q["citations"], lines)
        citations = [c for c in verified if c["verified"]] + [c for c in verified if not c["verified"]]
        if q["category"] in _NEEDS_CITATION and not any(c["verified"] and c["doc"] != "posting" for c in citations):
            continue
        seen.add(key)
        follow_ups = [clip(clean(f), INTERVIEW_LIMITS.followUpChars) for f in q["followUps"]]
        out.append(
            {
                "category": q["category"],
                "facet": normalize_facet(q["category"], q["facet"]),
                "question": question,
                "intent": clip(clean(q["intent"]), INTERVIEW_LIMITS.intentChars),
                "citations": citations,
                "followUps": [f for f in follow_ups if f][: INTERVIEW_LIMITS.followUpsPerQuestion],
            }
        )
        if len(out) >= INTERVIEW_LIMITS.questionsPerSession:
            break
    return out


# ---------------------------------------------------------------------------
# 피드백 정리 (TS src/lib/interview/service.ts)
# ---------------------------------------------------------------------------


def _clean_max(s: str, max_chars: int) -> str:
    t = clean(s)
    return f"{js_slice(t, 0, max_chars - 1)}…" if js_len(t) > max_chars else t


def _list(xs: list[str], n: int, max_chars: int = 300) -> list[str]:
    return [x for x in (_clean_max(x, max_chars) for x in xs) if x][:n]


def length_score(seconds: float, rng: dict[str, int]) -> int:
    """서버가 잰 말하기 길이 → 1~5점(권장 범위 안이면 5, 벗어난 정도만큼 깎는다)."""
    lo, hi = rng["min"], rng["max"]
    if lo <= seconds <= hi:
        return 5
    ratio = seconds / lo if seconds < lo else hi / seconds
    if ratio >= 0.75:
        return 4
    if ratio >= 0.5:
        return 3
    if ratio >= 0.25:
        return 2
    return 1


_SECONDS_RE = re.compile(f"[0-9]+{JS_WS_CLASS}*초")
_QUOTE_EDGES = re.compile(r"^[\"“'‘]+|[\"”'’]+\Z")


def _clamp_round(v: float, lo: int, hi: int) -> int:
    return max(lo, min(hi, js_round(v)))


def to_interview_feedback(output: dict[str, Any], answer: str, category: str, lines: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """LLM 출력 + 서버가 잰 길이 → interview_answers.feedback(jsonb) 형태. lines를 주지 않으면 ref를 그대로 둔다."""
    estimated = estimate_spoken_seconds(answer)
    rec = RECOMMENDED_ANSWER_SECONDS[category]
    known = {l["id"] for l in lines} if lines is not None else None
    criteria: dict[str, dict[str, Any]] = {}
    for k in INTERVIEW_CRITERIA:
        c = output["criteria"][k]
        criteria[k] = {"score": _clamp_round(c["score"], 1, 5), "comment": _clean_max(c["comment"], 400)}
    len_note = f"약 {estimated}초 분량(권장 {rec['min']}~{rec['max']}초)."
    llm_len = criteria["length"]["comment"]
    if not llm_len:
        comment = len_note
    elif _SECONDS_RE.search(llm_len):
        comment = llm_len
    else:
        comment = f"{len_note} {llm_len}"
    criteria["length"] = {"score": length_score(estimated, rec), "comment": _clean_max(comment, 400)}

    points: list[dict[str, Any]] = []
    for p in output["modelAnswer"]["points"]:
        raw_ref = p.get("ref")
        ref = (strip_ref(raw_ref) if isinstance(raw_ref, str) else "") or None
        points.append({"text": _clean_max(p["text"], 400), "ref": ref if ref and (known is None or ref in known) else None})
    points = [p for p in points if p["text"]][:4]

    return {
        "overall": _clamp_round(output["overall"], 0, 100),
        "criteria": criteria,
        "strengths": _list(output["strengths"], 3),
        "improvements": _list(output["improvements"], 4),
        "unsupportedClaims": _list(output["unsupportedClaims"], 3),
        "modelAnswer": {
            "conclusion": _clean_max(output["modelAnswer"]["conclusion"], 400),
            "points": points,
            "limitation": _clean_max(output["modelAnswer"]["limitation"], 400),
        },
        "followUp": _QUOTE_EDGES.sub("", _clean_max(output["followUp"], INTERVIEW_LIMITS.followUpChars)),
        "answerChars": js_len(remove_ws(answer)),
        "estimatedSeconds": estimated,
        "recommendedSeconds": {"min": rec["min"], "max": rec["max"]},
    }


# ---------------------------------------------------------------------------
# 실패 문구 (TS interviewErrorMessage + panel/runner.ts stageErrorMessage의 LlmPermanentError 분기)
# ---------------------------------------------------------------------------


class InterviewFeatureError(Exception):
    """TS FeatureError — 사용자에게 그대로 보여도 되는 문구(예: LLM 시간 상한)."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


_PERMANENT_MESSAGES: dict[str, str] = {
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
_STAGE_FALLBACK = "이 단계를 실행하는 중 오류가 발생했습니다. 다시 시도해 주세요."


def interview_error_message(err: BaseException, what: str) -> str:
    """사용자에게 보여도 되는 실패 문구. what은 '질문' 또는 '피드백'."""
    if isinstance(err, InterviewFeatureError):
        return err.message
    if isinstance(err, LlmPermanentError):
        stage = _PERMANENT_MESSAGES.get(err.reason, _STAGE_FALLBACK)
        return f"{what}을 만들지 못했습니다. {stage.replace('이 단계의 ', '', 1)}"
    if isinstance(err, TimeoutError):
        return f"{what}을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요."
    return f"{what}을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
