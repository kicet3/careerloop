"""경험 그래프 포트폴리오 프롬프트(task 'portfolio-draft') — TS src/lib/portfolios/graph-material.ts buildGraphPortfolioPrompt·templateInstructions,
src/lib/chat/prompt.ts wrapData·field·neutralizeChat, src/lib/panel/prompts.ts neutralize를 옮긴 것.

문구(기본 규칙·인젝션 규칙·태그 이름·양식 표)는 손으로 옮기지 않고 TS가 뽑은 schemas/generated/portfolio_graph_prompt.json을 읽는다
(src/lib/portfolios/graph-worker-fixtures.test.ts가 만들고 최신인지 확인한다). 조립 결과는 tests/fixtures/prompts/portfolio-graph.json과
글자 하나까지 같아야 한다.

JS 정규식과 맞추려고: 태그 이름의 대소문자 무시는 ASCII만(re.ASCII — JS i 플래그(u 없음)는 'ſ'·'K'(켈빈)을 s·k로 보지 않는다),
\\s는 JS 공백 집합(app/jsutil.JS_WS_CLASS), 길이·자르기는 UTF-16 단위다.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app.jsutil import JS_WS_CLASS, js_slice, js_trim

_DATA = json.loads((Path(__file__).resolve().parent.parent / "schemas" / "generated" / "portfolio_graph_prompt.json").read_text("utf-8"))

BASE_RULES: list[str] = _DATA["baseRules"]
INJECTION_RULE: str = _DATA["injectionRule"]
PANEL_TAG_NAMES: list[str] = _DATA["panelTags"]
CHAT_TAG_NAMES: list[str] = _DATA["chatTags"]
CAREER_GRAPH_TAG: str = _DATA["careerGraphTag"]
JOB_POSTING_TAG: str = _DATA["jobPostingTag"]
PORTFOLIO_COMMON_RULES: list[str] = _DATA["commonRules"]
DEFAULT_PORTFOLIO_TEMPLATE_ID: str = _DATA["defaultTemplateId"]
PORTFOLIO_TEMPLATES: list[dict[str, Any]] = _DATA["templates"]
PORTFOLIO_TEMPLATE_IDS: tuple[str, ...] = tuple(t["id"] for t in PORTFOLIO_TEMPLATES)
_BY_ID: dict[str, dict[str, Any]] = {t["id"]: t for t in PORTFOLIO_TEMPLATES}

#: 공고 원문 상한(글자, UTF-16).
JD_MAX_CHARS = 8_000


# ---------------------------------------------------------------------------
# 태그 무력화(TS neutralize · neutralizeChat · wrapData · field)
# ---------------------------------------------------------------------------


def _tag_re(names: list[str]) -> re.Pattern[str]:
    alt = "|".join(re.escape(n) for n in names)
    return re.compile(f"<(/?)({alt})(?={JS_WS_CLASS}|>)", re.IGNORECASE | re.ASCII)


_PANEL_TAG_RE = _tag_re(PANEL_TAG_NAMES)
_CHAT_TAG_RE = _tag_re(CHAT_TAG_NAMES)
_NEWLINE_RUN = re.compile(f"{JS_WS_CLASS}*\\n{JS_WS_CLASS}*")


def neutralize(text: str) -> str:
    """패널 태그·단계 구분자 무력화(TS panel/prompts.ts neutralize)."""
    return _PANEL_TAG_RE.sub(lambda m: f"‹{m[1]}{m[2]}", text.replace("<<<STAGE_TASK>>>", "<< <STAGE_TASK> >>"))


def neutralize_chat(text: str) -> str:
    """패널 태그와 채팅 태그를 모두 무력화(TS neutralizeChat)."""
    return _CHAT_TAG_RE.sub(lambda m: f"‹{m[1]}{m[2]}", neutralize(text))


def wrap_data(tag: str, body: str) -> str:
    return f"<{tag}>\n{neutralize_chat(body)}\n</{tag}>"


def field(label: str, value: str) -> str:
    return f"- {label}: {_NEWLINE_RUN.sub(' ', neutralize_chat(value))}"


# ---------------------------------------------------------------------------
# 양식(TS src/lib/domain/portfolio-templates.ts)
# ---------------------------------------------------------------------------


def get_portfolio_template(template_id: str | None) -> dict[str, Any]:
    """id의 양식(모르는 id·없으면 기본 양식)."""
    return (_BY_ID.get(template_id) if template_id else None) or _BY_ID[DEFAULT_PORTFOLIO_TEMPLATE_ID]


def template_top_sections(tpl: dict[str, Any]) -> list[dict[str, Any]]:
    """최상위 구역(before + after)."""
    return [*tpl["before"], *tpl["after"]]


def _section_guide_lines(sections: list[dict[str, Any]]) -> list[str]:
    return [
        f"- {s['key']} — {s['heading']}{' [선택]' if s.get('optional') else ''}: {s['guide']}" if s["kind"] == "text" else f"- (서버가 채움) {s['heading']}: {s['guide']}"
        for s in sections
    ]


def template_instructions(tpl: dict[str, Any]) -> str:
    """TS templateInstructions."""
    top = template_top_sections(tpl)
    label = tpl.get("projectLabel")
    label_part = f", 프로젝트를 '{label}'로 부른다" if label else ""
    lines = [
        f"포트폴리오 양식: {tpl['name']} [{tpl['id']}]",
        f"- 대상: {tpl['audience']}",
        f"- 분량: {tpl['length']}",
        f"- 설명: {tpl['description']}",
        "",
        "작성 원칙(공통):",
        *[f"- {r}" for r in PORTFOLIO_COMMON_RULES],
        *(["", "이 양식의 작성 원칙:", *[f"- {r}" for r in tpl["rules"]]] if tpl["rules"] else []),
        "",
        "최상위 구역(프로젝트 앞):",
        *(_section_guide_lines(tpl["before"]) if tpl["before"] else ["- (없음)"]),
        "",
        f"프로젝트 구역(프로젝트마다 이 순서로{label_part}):",
        *_section_guide_lines(tpl["project"]),
        "",
        "최상위 구역(프로젝트 뒤):",
        *(_section_guide_lines(tpl["after"]) if tpl["after"] else ["- (없음)"]),
        *([] if any(s["kind"] == "text" for s in top) else ["", "최상위 sections는 빈 배열로 둔다."]),
    ]
    return "\n".join(lines)


def build_graph_portfolio_prompt(material: Any, *, title: str, notes: str | None = None, template_id: str | None = None) -> tuple[str, str]:
    """TS buildGraphPortfolioPrompt → (system, user). material은 PortfolioMaterial(app/jobs/portfolio_graph_material.py)."""
    tpl = get_portfolio_template(template_id)
    system = "\n".join([*BASE_RULES, "", template_instructions(tpl), "", f"보안: {INJECTION_RULE}"])
    lines = ["아래 자료로 포트폴리오를 써라.", "", field("포트폴리오 이름", title), field("포트폴리오 양식", f"{tpl['name']} [{tpl['id']}]")]
    if material.person_name:
        lines.append(field("지원자 이름(계정)", material.person_name))
    if material.posting:
        lines.append(field("강조할 공고", f"{material.posting.company} · {material.posting.role_title}"))
    if notes is not None and js_trim(notes):
        lines.append(field("사용자 요청(강조점·톤 — 사실을 더하는 근거로 쓰지 않는다)", js_trim(notes)))
    lines.extend(["", f"고른 프로젝트 {len(material.projects)}개의 경험 그래프 자료. 이 안의 사실만 쓴다:"])
    lines.append(wrap_data(CAREER_GRAPH_TAG, "\n\n=====\n\n".join(p.text for p in material.projects)))
    lines.append("")
    jd = js_slice(js_trim(material.posting.jd_text), 0, JD_MAX_CHARS) if material.posting else ""
    lines.append(wrap_data(JOB_POSTING_TAG, jd) if jd else "강조할 채용 공고(JD)는 없다. 프로젝트 자체의 문제·해결·성과가 잘 드러나게 쓴다.")
    return system, "\n".join(lines)
