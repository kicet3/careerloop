"""이력서 문장 끝 경어체 통일 — TS src/lib/resumes/honorific.ts의 워커판(글자 하나까지 같아야 한다).

tests/fixtures/honorific.json(TS src/lib/resumes/honorific.test.ts가 만든다)의 입력 → 출력을 pytest가 확인한다.
확실한 평어체 종결만 바꾸고(했다→했습니다, 한다→합니다, 이다→입니다, 있다→있습니다 …) 판단할 수 없는 문장은 leftovers로 돌려준다.
길이·자르기는 JS와 같게 UTF-16 단위(app.jsutil)로 센다.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any

from app.jsutil import js_len, js_slice, js_trim

#: 프롬프트 규칙(TS HONORIFIC_RULE).
HONORIFIC_RULE = "문체: 문장으로 끝나는 줄(요약·한 줄 소개·경력 담당 범위와 불릿·프로젝트 요약·문제·행동·결과·직무 역량 설명·수상·기타 설명·지원 동기)은 모두 경어체 '~했습니다/~합니다/~입니다'로 끝낸다. 평어체 '~했다/~한다/~이다/~였다/~있다'로 끝내지 않는다. 예: (틀림) '정산 배치 시간을 40% 줄였다.' → (맞음) '정산 배치 시간을 40% 줄였습니다.' / (틀림) '주문 API를 설계하고 운영한다.' → (맞음) '주문 API를 설계하고 운영합니다.' / (틀림) '결제 도메인 3년 차 백엔드 개발자이다.' → (맞음) '결제 도메인 3년 차 백엔드 개발자입니다.' 'API 응답 40% 개선'처럼 명사로 끝나는 개조식 줄은 그대로 둘 수 있다. 문체만 맞추고 뜻·수치·고유명사·[ADD: …] 자리표시는 바꾸지 않는다."

_HANGUL_FIRST = 0xAC00
_HANGUL_LAST = 0xD7A3
_JONG_NONE = 0
_JONG_N = 4  # ㄴ
_JONG_L = 8  # ㄹ
_JONG_B = 17  # ㅂ
_JONG_SS = 20  # ㅆ

#: TS ENDING_RE(/…(?=[ \t]*(?:[.!?。…]|\r?\n|$))/g — u·m 플래그 없음: $는 문자열 끝).
_ENDING_RE = re.compile("([가-힣]*)다(?=[ \t]*(?:[.!?。…]|\r?\n|\\Z))")
_PROTECTED_RE = re.compile(r"\[ADD:[^\]]*\]|\"[^\"\n]*\"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』")
_NOT_ENDING_SUFFIXES = ("바다", "보다", "마다", "람다", "혼다", "아젠다", "어젠다", "프로파간다", "캐나다", "우간다", "르완다")
_AMBIGUOUS_I_NOUNS = ("차이", "사이", "아이", "나이", "길이", "깊이", "넓이", "놀이")
_NON_HANGUL_BEFORE_RE = re.compile(r"[0-9A-Za-z%)\]]")
_SENTENCE_BOUNDARY = ".!?。\n"
_SNIPPET_MAX = 60


def _is_syllable(ch: str | None) -> bool:
    return bool(ch) and _HANGUL_FIRST <= ord(ch) <= _HANGUL_LAST  # type: ignore[arg-type]


def _jong(ch: str) -> int:
    return (ord(ch) - _HANGUL_FIRST) % 28


def _with_jong(ch: str, j: int) -> str:
    return chr(ord(ch) - _jong(ch) + j)


_SKIP = object()


def _convert_token(stem: str) -> Any:
    """stem + '다' → 경어체. 평어체 종결이 아니면 _SKIP, 판단할 수 없으면 None."""
    p = stem[-1] if stem else None
    if not _is_syllable(p):
        return None
    assert p is not None
    pp = stem[-2] if len(stem) >= 2 else None
    head = stem[:-1]
    j = _jong(p)
    if any(f"{stem}다".endswith(s) for s in _NOT_ENDING_SUFFIXES):
        return _SKIP
    if p == "니":
        if _is_syllable(pp) and _jong(pp) == _JONG_B:  # type: ignore[arg-type]
            return _SKIP
        if pp == "아":
            return f"{head[:-1]}아닙니다"
        return None
    if j == _JONG_SS:
        return f"{stem}습니다"
    if j == _JONG_NONE:
        if p == "하":
            return f"{head}합니다"
        if p == "이":
            return None if stem.endswith(_AMBIGUOUS_I_NOUNS) else f"{head}입니다"
        return None
    if j == _JONG_N:
        if p == "는":
            if _is_syllable(pp) and _jong(pp) not in (_JONG_NONE, _JONG_L):  # type: ignore[arg-type]
                return f"{head}습니다"
            return None
        return f"{head}{_with_jong(p, _JONG_B)}니다"
    if j == _JONG_L:
        return None
    return f"{stem}습니다"


def _snippet_at(text: str, start: int, end: int) -> str:
    s = start
    while s > 0 and text[s - 1] not in _SENTENCE_BOUNDARY:
        s -= 1
    t = js_trim(text[s:end])
    n = js_len(t)
    return f"…{js_slice(t, n - (_SNIPPET_MAX - 1))}" if n > _SNIPPET_MAX else t


@dataclass(frozen=True)
class PlainEnding:
    index: int
    token: str
    replacement: str | None
    snippet: str


def detect_plain_endings(text: str) -> list[PlainEnding]:
    """문장 끝 평어체 종결(TS detectPlainEndings). 위치는 Python 문자열 인덱스(코드 포인트)."""
    ranges = [(m.start(), m.end()) for m in _PROTECTED_RE.finditer(text)]
    out: list[PlainEnding] = []
    for m in _ENDING_RE.finditer(text):
        stem = m[1]
        da_at = m.start() + len(stem)
        if any(a <= da_at < b for a, b in ranges):
            continue
        if stem == "":
            before = text[m.start() - 1] if m.start() > 0 else ""
            if not before or not _NON_HANGUL_BEFORE_RE.match(before):
                continue
            replacement: Any = None
        else:
            replacement = _convert_token(stem)
            if replacement is _SKIP:
                continue
        out.append(PlainEnding(m.start(), m[0], replacement, _snippet_at(text, m.start(), m.end())))
    return out


@dataclass
class HonorificResult:
    text: str
    leftovers: list[str] = field(default_factory=list)
    changed: int = 0


def normalize_honorific(text: str) -> HonorificResult:
    """TS normalizeHonorific."""
    parts: list[str] = []
    last = 0
    changed = 0
    for f in detect_plain_endings(text):
        if f.replacement is None:
            continue
        parts.append(text[last : f.index])
        parts.append(f.replacement)
        last = f.index + len(f.token)
        changed += 1
    parts.append(text[last:])
    out = "".join(parts)
    return HonorificResult(out, [f.snippet for f in detect_plain_endings(out)], changed)


@dataclass
class DocumentHonorificResult:
    document: dict[str, Any]
    changed: int
    leftovers: list[dict[str, str]]


def normalize_document_honorific(doc: dict[str, Any]) -> DocumentHonorificResult:
    """TS normalizeDocumentHonorific — 서술 칸만(입력은 바꾸지 않는다)."""
    d = copy.deepcopy(doc)
    changed = 0
    leftovers: list[dict[str, str]] = []

    def fix(path: str, value: str) -> str:
        nonlocal changed
        if not value:
            return value
        r = normalize_honorific(value)
        changed += r.changed
        leftovers.extend({"path": path, "text": t} for t in r.leftovers)
        return r.text

    d["basics"]["tagline"] = fix("basics.tagline", d["basics"]["tagline"])
    d["summary"] = fix("summary", d["summary"])
    for i, h in enumerate(d["highlights"]):
        h["title"] = fix(f"highlights[{i}].title", h["title"])
        h["context"] = fix(f"highlights[{i}].context", h["context"])
    for i, e in enumerate(d["experience"]):
        e["scope"] = fix(f"experience[{i}].scope", e["scope"])
        e["bullets"] = [fix(f"experience[{i}].bullets[{j}]", b) for j, b in enumerate(e["bullets"])]
    for i, p in enumerate(d["projects"]):
        for k in ("summary", "problem", "action", "result"):
            p[k] = fix(f"projects[{i}].{k}", p[k])
        p["bullets"] = [fix(f"projects[{i}].bullets[{j}]", b) for j, b in enumerate(p["bullets"])]
    for i, s in enumerate(d["skills"]):
        s["detail"] = fix(f"skills[{i}].detail", s["detail"])
    for i, x in enumerate(d["extras"]):
        x["items"] = [fix(f"extras[{i}].items[{j}]", t) for j, t in enumerate(x["items"])]
    d["motivation"] = fix("motivation", d["motivation"])
    return DocumentHonorificResult(d, changed, leftovers)


def honorific_leftover_note(leftovers: list[dict[str, str]]) -> str | None:
    """TS honorificLeftoverNote."""
    if not leftovers:
        return None
    first = leftovers[0]["text"]
    more = " 외" if len(leftovers) > 1 else ""
    return f"문장 끝을 '~습니다'로 자동으로 바꾸지 못한 문장 {len(leftovers)}개가 있습니다. 직접 확인해 주세요: '{first}'{more}"
