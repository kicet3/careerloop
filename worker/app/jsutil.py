"""TS(JavaScript)와 글자 하나까지 같은 문자열을 만들기 위한 도우미.

- JS 문자열 길이·자르기는 UTF-16 코드 단위다(이모지 하나 = 2). Python len·슬라이스는 코드 포인트라 다르다.
- JS 정규식의 \\s·String.prototype.trim이 공백으로 보는 문자 집합은 Python str.isspace와 다르다.
- String(value)는 불리언을 'true'/'false', 정수 값 실수를 '2'로 쓴다.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

#: JS 정규식 \s와 trim()이 공백으로 보는 문자(ECMAScript WhiteSpace + LineTerminator).
JS_WS_CLASS = "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
_WS_RUN = re.compile(f"{JS_WS_CLASS}+")
_LEADING = re.compile(f"^{JS_WS_CLASS}+")
_TRAILING = re.compile(f"{JS_WS_CLASS}+\\Z")


_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def well_formed(s: str) -> str:
    """외톨이 서로게이트(js_slice가 이모지를 가를 때 남는다)를 U+FFFD로 — JS String.prototype.toWellFormed, Node가 UTF-8로 보낼 때와 같은 결과.
    Python은 그대로 두면 UTF-8 인코딩(Anthropic SDK 본문·psycopg·저장소)에서 UnicodeEncodeError가 난다.
    짝이 맞는 서로게이트는 Python str에서 이미 한 코드 포인트로 합쳐져 있으므로, 남은 서로게이트 코드 포인트는 모두 외톨이다."""
    return _LONE_SURROGATE.sub("\ufffd", s) if _LONE_SURROGATE.search(s) else s


def well_formed_deep(v: Any) -> Any:
    """JSON 값 안의 모든 문자열·키에 well_formed를 적용한다."""
    if isinstance(v, str):
        return well_formed(v)
    if isinstance(v, list):
        return [well_formed_deep(x) for x in v]
    if isinstance(v, tuple):
        return tuple(well_formed_deep(x) for x in v)
    if isinstance(v, dict):
        return {(well_formed(k) if isinstance(k, str) else k): well_formed_deep(x) for k, x in v.items()}
    return v


def js_len(s: str) -> int:
    """UTF-16 코드 단위 길이(JS string.length)."""
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def js_slice(s: str, start: int, end: int | None = None) -> str:
    """UTF-16 코드 단위로 자른다(JS string.slice, 음수 인덱스 없음). 서로게이트 쌍을 가르면 JS처럼 외톨이 서로게이트가 남는다."""
    b = s.encode("utf-16-le", "surrogatepass")
    e = len(b) if end is None else min(len(b), max(0, end) * 2)
    return b[max(0, start) * 2 : e].decode("utf-16-le", "surrogatepass")


def js_trim(s: str) -> str:
    return _TRAILING.sub("", _LEADING.sub("", s))


def js_collapse_ws(s: str) -> str:
    """s.replace(/\\s+/g, " ")"""
    return _WS_RUN.sub(" ", s)


def js_number(n: float | int) -> str:
    """Number.prototype.toString (일반적인 범위)."""
    if isinstance(n, bool):
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if math.isnan(n):
        return "NaN"
    if math.isinf(n):
        return "Infinity" if n > 0 else "-Infinity"
    if n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    r = repr(n)
    if "e" in r:
        mant, exp = r.split("e")
        sign = "-" if exp.startswith("-") else "+"
        return f"{mant}e{sign}{int(exp.lstrip('+-'))}"
    return r


def js_string(v: Any) -> str:
    """String(v)."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_number(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ",".join("" if x is None else js_string(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    return str(v)


def js_json(v: Any) -> str:
    """JSON.stringify(v) — 공백 없음, 한글 그대로."""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
