"""경험 그래프 날짜(읽기 경로) — TS src/lib/domain/graph-dates.ts의 parseGraphDate·normalizeStoredDates를 옮긴 것.
공유 fixture(tests/fixtures/graph.json)로 TS와 결과가 같은지 확인한다.

JS 정규식과 맞추려고: \\d 대신 [0-9](Python \\d는 다른 문자 체계 숫자도 받는다), $ 대신 fullmatch·\\Z(Python $는 끝 줄바꿈 앞에서도 맞는다),
\\s 대신 JS 공백 집합을 쓴다.
"""

from __future__ import annotations

import calendar
import re
import unicodedata
from typing import Any

from app.jsutil import JS_WS_CLASS as W, js_collapse_ws, js_len, js_trim

GRAPH_DATE_KEYS = ("startDate", "endDate", "date")
ONGOING_LABELS = frozenset({"Role", "Project", "Experience", "Education"})
STORED_DATE_RE = re.compile(r"[0-9]{4}(-(0[1-9]|1[0-2]))?")

MIN_YEAR = 1950
MAX_YEAR = 2100

_I = re.IGNORECASE
_ONGOING_RE = re.compile(
    rf"(?:~{W}*)?(?:현재|지금|오늘|현재{W}*까지|지금{W}*까지|오늘{W}*까지|진행{W}*중|재직{W}*중|재학{W}*중|근무{W}*중|참여{W}*중|활동{W}*중|운영{W}*중|개발{W}*중|"
    rf"현재{W}*(?:진행|재직|재학|근무|참여|활동|운영|개발){W}*중?|계속|now|present|current|currently|ongoing|to{W}*date|till{W}*now|until{W}*now|in{W}*progress)(?:{W}*~)?",
    _I,
)
_EMPTY_RE = re.compile(r"(?:[~\-–—?·.]+|모름|미정|없음|미상|n/?a|none|unknown|tbd|null|undefined)", _I)

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "june": 6, "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
}  # fmt: skip

_ISO = re.compile(r"([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[T ][0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?")
_YMD = re.compile(rf"'?([0-9]{{4}}|[0-9]{{2}}){W}*(?:[./-]|년){W}*([0-9]{{1,2}}){W}*(?:[./-]|월){W}*([0-9]{{1,2}}){W}*일?\.?")
_YM = re.compile(rf"'?([0-9]{{4}}|[0-9]{{2}}){W}*(?:[./-]|년){W}*([0-9]{{1,2}}){W}*월?\.?")
_COMPACT = re.compile(r"([0-9]{4})([0-9]{2})([0-9]{2})?")
_MY = re.compile(rf"([0-9]{{1,2}}){W}*[./-]{W}*([0-9]{{4}})")
_MONTH_NAME_Y = re.compile(rf"([a-z]{{3,9}})\.?,?{W}*([0-9]{{4}})", _I)
_Y_MONTH_NAME = re.compile(rf"([0-9]{{4}}){W}*([a-z]{{3,9}})\.?", _I)
_YEAR = re.compile(rf"([0-9]{{4}}){W}*년?(?:{W}*(?:상반기|하반기|초|초반|중반|말|후반|봄|여름|가을|겨울|[1-4]{W}*분기|q[1-4]))?", _I)
_REL_YEAR = re.compile(rf"(올해|금년|작년|지난{W}*해|재작년)(?:{W}*([0-9]{{1,2}}){W}*월)?")
_THIS_MONTH = re.compile(rf"(이번{W}*달|이달)")
_LAST_MONTH = re.compile(rf"(지난{W}*달|저번{W}*달)")
_TODAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _ym(year: int, month: int | None) -> str | None:
    if year < MIN_YEAR or year > MAX_YEAR:
        return None
    if month is None:
        return str(year)
    if month < 1 or month > 12:
        return None
    return f"{year}-{month:02d}"


def _full_year(yy: str) -> int:
    return int(yy) if len(yy) == 4 else int(yy) + (2000 if int(yy) < 70 else 1900)


def _valid_day(year: int, month: int, day: int) -> bool:
    if day < 1 or day > 31 or month < 1 or month > 12:
        return False
    return day <= calendar.monthrange(year, month)[1]


def _date(y: int, mo: int | None) -> dict[str, str]:
    out = _ym(y, mo)
    return {"kind": "date", "value": out} if out else {"kind": "invalid"}


def parse_graph_date(raw: Any, today: str | None = None) -> dict[str, str]:
    """날짜 표기 하나 → {'kind': 'date', 'value'} | {'kind': 'ongoing'|'empty'|'invalid'}. TS parseGraphDate와 같다."""
    if raw is None:
        return {"kind": "empty"}
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        from app.jsutil import js_number

        return parse_graph_date(js_number(raw), today)
    if not isinstance(raw, str):
        return {"kind": "invalid"}
    v = js_collapse_ws(js_trim(unicodedata.normalize("NFKC", raw)))
    if v == "":
        return {"kind": "empty"}
    if js_len(v) > 40:
        return {"kind": "invalid"}
    if _EMPTY_RE.fullmatch(v):
        return {"kind": "empty"}
    if _ONGOING_RE.fullmatch(v):
        return {"kind": "ongoing"}
    s = js_trim(re.sub(r"\.\Z", "", re.sub(r"\A'", "", v)))

    if m := _ISO.fullmatch(s):
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
        return _date(y, mo) if _valid_day(y, mo, d) else {"kind": "invalid"}
    if m := _YMD.fullmatch(s):
        y, mo, d = _full_year(m[1]), int(m[2]), int(m[3])
        return _date(y, mo) if _valid_day(y, mo, d) else {"kind": "invalid"}
    if m := _YM.fullmatch(s):
        return _date(_full_year(m[1]), int(m[2]))
    if m := _COMPACT.fullmatch(s):
        y, mo = int(m[1]), int(m[2])
        if m[3] and not _valid_day(y, mo, int(m[3])):
            return {"kind": "invalid"}
        return _date(y, mo)
    if m := _MY.fullmatch(s):
        return _date(int(m[2]), int(m[1]))
    if (m := _MONTH_NAME_Y.fullmatch(s)) and _MONTHS.get(m[1].lower()):
        return _date(int(m[2]), _MONTHS[m[1].lower()])
    if (m := _Y_MONTH_NAME.fullmatch(s)) and _MONTHS.get(m[2].lower()):
        return _date(int(m[1]), _MONTHS[m[2].lower()])
    if m := _YEAR.fullmatch(s):
        return _date(int(m[1]), None)
    if today and _TODAY.fullmatch(today):
        ty, tm = int(today[0:4]), int(today[5:7])
        if m := _REL_YEAR.fullmatch(s):
            back = 2 if "재작년" in m[1] else 1 if re.search("작년|지난", m[1]) else 0
            return _date(ty - back, int(m[2]) if m[2] else None)
        if _THIS_MONTH.fullmatch(s):
            return _date(ty, tm)
        if _LAST_MONTH.fullmatch(s):
            return _date(ty - 1, 12) if tm == 1 else _date(ty, tm - 1)
    return {"kind": "invalid"}


def _is_real_date(v: Any) -> bool:
    return isinstance(v, str) and js_trim(v) != ""


def normalize_stored_dates(label: str, props: dict[str, Any]) -> dict[str, Any]:
    """저장된 노드 속성(옛 형식 포함) → 계약대로 보이는 값(읽기 전용). TS normalizeStoredDates와 같다. 바뀌지 않으면 같은 dict를 돌려준다."""
    out: dict[str, Any] | None = None

    def put(k: str, v: Any, remove: bool = False) -> None:
        nonlocal out
        if out is None:
            out = dict(props)
        if remove:
            out.pop(k, None)
        else:
            out[k] = v

    for key in GRAPH_DATE_KEYS:
        raw = props.get(key)
        if not isinstance(raw, str) or STORED_DATE_RE.fullmatch(raw):
            continue
        p = parse_graph_date(raw)
        if p["kind"] == "date":
            put(key, p["value"])
        elif p["kind"] == "ongoing" and key == "endDate" and label in ONGOING_LABELS:
            put("endDate", None, remove=True)
            put("current", True)
    if props.get("current") is True and _is_real_date(props.get("endDate")) and label in ONGOING_LABELS:
        put("endDate", None, remove=True)
    return out if out is not None else props
