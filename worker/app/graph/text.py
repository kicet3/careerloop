"""경험 그래프 → LLM 프롬프트용 텍스트(순수 함수). TS src/lib/graph/text.ts graphToText와 글자 하나까지 같다
(길이·자르기는 UTF-16 단위, 값 문자열화는 JS String() 규칙 — app/jsutil.py). 사용자 입력 값이므로 호출자가 데이터 태그로 감싸고 neutralize한다.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.graph.domain import NODE_LABEL_META, NODE_LABELS, NODE_TITLE_KEY, PERSON_ID, REL_NAMES, CareerGraph, GraphNode, node_display_name
from app.jsutil import js_collapse_ws, js_len, js_slice, js_string

DEFAULT_MAX_CHARS = 12_000
PROP_CAPS: tuple[int, ...] = (200, 120, 60, 30, 0)


def _props_text(node: GraphNode, cap: int) -> str:
    if cap <= 0:
        return ""
    title_key = NODE_TITLE_KEY[node.label]
    parts: list[str] = []
    for k, v in node.props.items():
        if k == title_key or v is None or v == "":
            continue
        full = js_collapse_ws("|".join("" if x is None else js_string(x) for x in v) if isinstance(v, list) else js_string(v))
        parts.append(f"{k}={js_slice(full, 0, cap)}…(잘림)" if js_len(full) > cap else f"{k}={full}")
    return f" ({', '.join(parts)})" if parts else ""


@dataclass
class _Section:
    header: str
    what: str
    lines: list[str]


def _section_length(sec: _Section) -> int:
    return js_len(sec.header) + 1 + sum(js_len(line) + 1 for line in sec.lines)


def _join(secs: Sequence[_Section]) -> str:
    return "\n".join("\n".join([s.header, *s.lines]) for s in secs)


def graph_to_text(graph: CareerGraph, max_chars: int | None = None, prop_caps: Sequence[int] | None = None) -> str:
    """TS graphToText(graph, { maxChars, propCaps })."""
    limit = DEFAULT_MAX_CHARS if max_chars is None else max_chars
    if not graph.nodes:
        return "(아직 정리된 경력·경험이 없다)"
    by_id = {n.id: n for n in graph.nodes}

    def name(node_id: str) -> str:
        if node_id == PERSON_ID:
            return "나(me)"
        n = by_id.get(node_id)
        return f"{node_display_name(n) if n else '?'}[{node_id}]"

    edge_lines = [f"- {name(e.from_)} -{e.type}({REL_NAMES[e.type]})-> {name(e.to)}" for e in graph.edges]

    def sections_with(cap: int) -> list[_Section]:
        secs: list[_Section] = []
        for label in NODE_LABELS:
            nodes = [n for n in graph.nodes if n.label == label]
            if not nodes:
                continue
            meta = NODE_LABEL_META[label]
            secs.append(_Section(f"## {meta['name']} ({label})", meta["name"], [f"- [{n.id}] {node_display_name(n)}{_props_text(n, cap)}" for n in nodes]))
        if edge_lines:
            secs.append(_Section("## 관계", "관계", list(edge_lines)))
        return secs

    for cap in PROP_CAPS if prop_caps is None else prop_caps:
        text = _join(sections_with(cap))
        if js_len(text) <= limit:
            return text

    secs = sections_with(0)
    kept: dict[int, list[str]] = {}
    remaining = limit
    order = sorted(secs, key=_section_length)
    for i, sec in enumerate(order):
        share = remaining // (len(order) - i)

        def note(n: int, sec: _Section = sec) -> str:
            return f"… (생략: {sec.what} {n}개 — 그래프가 길어 줄였다)"

        used = js_len(sec.header) + 1
        lines: list[str] = []
        for j, line in enumerate(sec.lines):
            rest = len(sec.lines) - j - 1
            reserve = js_len(note(rest)) + 1 if rest > 0 else 0
            if used + js_len(line) + 1 + reserve > share:
                break
            lines.append(line)
            used += js_len(line) + 1
        if len(lines) < len(sec.lines):
            n = len(sec.lines) - len(lines)
            lines.append(note(n))
            used += js_len(note(n)) + 1
        kept[id(sec)] = lines
        remaining -= used
    return _join([_Section(s.header, s.what, kept[id(s)]) for s in secs])
