"""경험 그래프 포트폴리오의 순수 규칙 — TS에서 옮긴 것(tests/fixtures/prompts/portfolio-graph-postprocess.json으로 TS와 결과가 같은지 확인한다).

- parse_start_input: StartGraphPortfolioSchema.safeParse(작업 행 input) — src/lib/domain/graph-portfolio.ts
- unverified_numbers·strip_placeholders: src/lib/text/numbers.ts
- sanitize_portfolio_output: src/lib/portfolios/graph-material.ts sanitizePortfolioOutput(지어낸 수치 표시·양식 key 정리)
- graph_portfolio_to_markdown·count_portfolio_add_markers: src/lib/domain/graph-portfolio.ts
- graph_portfolio_error_message: src/lib/portfolios/graph-jobs.ts graphPortfolioErrorMessage(+ panel/runner.ts stageErrorMessage의 LLM 실패 문구)

출력 dict는 TS와 같은 camelCase 키(LLM 출력 스키마 graph_portfolio_output.json)를 쓴다.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from app.jsutil import js_collapse_ws, js_len, js_slice, js_trim
from app.llm.types import LlmPermanentError
from app.prompts.portfolio_graph import DEFAULT_PORTFOLIO_TEMPLATE_ID, PORTFOLIO_TEMPLATE_IDS, get_portfolio_template, template_top_sections

# TS src/lib/domain/graph-portfolio.ts·portfolios.ts와 같은 상한.
MAX_GRAPH_PORTFOLIO_PROJECTS = 12
MAX_GRAPH_PORTFOLIO_NOTES_CHARS = 1000
MAX_PORTFOLIO_TITLE_CHARS = 120
_ID_MAX = 64
_PROVIDER_MAX = 40


class PortfolioJobError(Exception):
    """사용자에게 그대로 보여도 되는 실패(TS FeatureError). message가 작업 행 error 열에 들어간다."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------
# 시작 입력(StartGraphPortfolioSchema)
# ---------------------------------------------------------------------------

_MISSING = object()


def _trimmed(v: Any, *, min_len: int = 0, max_len: int) -> str | None:
    if not isinstance(v, str):
        return None
    t = js_trim(v)
    n = js_len(t)
    return t if min_len <= n <= max_len else None


def parse_start_input(raw: Any) -> dict[str, Any] | None:
    """작업 행 input → 검증한 입력(모르는 키는 버린다). 틀리면 None(TS safeParse 실패와 같다)."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    ids = raw.get("projectIds", _MISSING)
    if not isinstance(ids, list) or not (1 <= len(ids) <= MAX_GRAPH_PORTFOLIO_PROJECTS):
        return None
    cleaned: list[str] = []
    for x in ids:
        t = _trimmed(x, min_len=1, max_len=_ID_MAX)
        if t is None:
            return None
        cleaned.append(t)
    out["projectIds"] = list(dict.fromkeys(cleaned))

    for key in ("postingId", "portfolioId"):
        v = raw.get(key, _MISSING)
        if v is _MISSING:
            continue
        if v is None:
            out[key] = None
            continue
        t = _trimmed(v, min_len=1, max_len=_ID_MAX)
        if t is None:
            return None
        out[key] = t
    for key, max_len in (("title", MAX_PORTFOLIO_TITLE_CHARS), ("notes", MAX_GRAPH_PORTFOLIO_NOTES_CHARS)):
        v = raw.get(key, _MISSING)
        if v is _MISSING:
            continue
        t = _trimmed(v, max_len=max_len)
        if t is None:
            return None
        out[key] = t
    tid = raw.get("templateId", _MISSING)
    if tid is _MISSING:
        out["templateId"] = DEFAULT_PORTFOLIO_TEMPLATE_ID
    elif isinstance(tid, str) and tid in PORTFOLIO_TEMPLATE_IDS:
        out["templateId"] = tid
    else:
        return None
    prov = raw.get("provider", _MISSING)
    if prov is not _MISSING:
        if prov is None:
            out["provider"] = None
        else:
            t = _trimmed(prov, max_len=_PROVIDER_MAX)
            if t is None:
                return None
            out["provider"] = t
    return out


# ---------------------------------------------------------------------------
# 수치 확인(src/lib/text/numbers.ts)
# ---------------------------------------------------------------------------

_NUM_RE = re.compile(r"[0-9]+(?:[.,][0-9]+)*")
_ADD_RE = re.compile(r"\[ADD:[^\]]*\]")


def unverified_numbers(text: str, source: str) -> list[str]:
    """text의 숫자 중 source에 없는 것(쉼표는 무시, 처음 나온 순서)."""
    known = {m.replace(",", "") for m in _NUM_RE.findall(source)}
    return [n for n in dict.fromkeys(m.replace(",", "") for m in _NUM_RE.findall(text)) if n not in known]


def strip_placeholders(s: str) -> str:
    return _ADD_RE.sub(" ", s)


def count_portfolio_add_markers(text: str) -> int:
    return len(_ADD_RE.findall(text))


# ---------------------------------------------------------------------------
# 출력 정리(sanitizePortfolioOutput)
# ---------------------------------------------------------------------------

_NON_KEY = re.compile(r"[^A-Za-z0-9_-]")
_BRACKETS = re.compile(r"[\[\]]")
_PROJECT_ID_EDGE = re.compile(r"^\[|\]\Z")


def norm_key(k: str) -> str:
    """TS normKey: k.replace(/[^a-z0-9_-]/gi, "").toLowerCase() — JS i 플래그(u 없음)는 ASCII 밖 문자를 a-z로 보지 않는다."""
    return _NON_KEY.sub("", k).lower()


def sections_by_key(sections: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    """sections → key별 첫 구역."""
    out: dict[str, Mapping[str, Any]] = {}
    for s in sections:
        k = norm_key(s["key"])
        if k and k not in out:
            out[k] = s
    return out


def sanitize_portfolio_output(out: Mapping[str, Any], material: Any, template_id: str | None = None) -> dict[str, Any]:
    """TS sanitizePortfolioOutput. material은 PortfolioMaterial(projects[].id·name·text, person_name)."""
    tpl = get_portfolio_template(template_id)
    missing: list[str] = list(out["missingInfo"])
    all_source = "\n".join(["\n".join(p.text for p in material.projects), material.person_name or ""])

    def flag(line: str, source: str) -> str:
        bad = unverified_numbers(strip_placeholders(line), source)
        if not bad:
            return line
        missing.append(f"'{js_slice(line, 0, 80)}' — 경험 그래프에 없는 수치({', '.join(bad)})라 확인이 필요합니다. 맞다면 그래프에도 적어 주세요.")
        return f"[ADD: 수치 확인 — {_BRACKETS.sub('', line)}]"

    def opt(line: str, source: str) -> str:
        return flag(line, source) if line else line

    def sections(lst: Sequence[Mapping[str, Any]], allowed: Sequence[Mapping[str, Any]], source: str) -> list[dict[str, Any]]:
        by_key = sections_by_key(lst)
        res: list[dict[str, Any]] = []
        for sec in allowed:
            s = by_key.get(sec["key"]) if sec["kind"] == "text" else None
            if s is None:
                continue
            res.append({"key": sec["key"], "body": opt(s["body"], source), "bullets": [flag(b, source) for b in s["bullets"]]})
        return res

    by_id: dict[str, Mapping[str, Any]] = {}
    for p in out["projects"]:
        by_id[js_trim(_PROJECT_ID_EDGE.sub("", p["projectId"]))] = p
    projects: list[dict[str, Any]] = []
    for mp in material.projects:
        p = by_id.get(mp.id)
        if p is None:
            missing.append(f"'{mp.name}' 프로젝트를 AI가 쓰지 않았습니다. 다시 만들거나 직접 더해 주세요.")
            continue
        projects.append({**p, "projectId": mp.id, "oneLiner": opt(p["oneLiner"], mp.text), "sections": sections(p["sections"], tpl["project"], mp.text)})
    return {
        **out,
        "headline": opt(out["headline"], all_source),
        "sections": sections(out["sections"], template_top_sections(tpl), all_source),
        "projects": projects,
        "missingInfo": list(dict.fromkeys(missing))[:30],
    }


# ---------------------------------------------------------------------------
# Markdown(graphPortfolioToMarkdown)
# ---------------------------------------------------------------------------

_GITHUB_URL = re.compile(r"^https://github\.com/")


def _clean(s: str | None) -> str:
    return js_trim(js_collapse_ws(s or ""))


def _list_item(s: str) -> str:
    return f"- {_clean(s)}"


def _link_item(link: Mapping[str, str]) -> str:
    return _list_item(f"[{_BRACKETS.sub('', link['label'])}]({link['url']})")


def _section_lines(sec: Mapping[str, Any], level: int, *, content: Mapping[str, Any] | None, skills: Sequence[str], links: Sequence[Mapping[str, str]], contact: Sequence[Mapping[str, str]], toc: Sequence[str], chips: bool) -> list[str]:
    head = f"{'#' * level} {sec['heading']}"
    missing = [] if sec.get("optional") else ["", head, "", f"[ADD: {sec['heading']} 보완 필요]"]
    kind = sec["kind"]
    if kind == "skills":
        names = [n for n in (_clean(x) for x in skills) if n]
        if not names:
            return []
        return ["", head, "", " ".join(f"`{n.replace('`', '')}`" for n in names) if chips else " · ".join(names)]
    if kind == "links":
        return ["", head, "", *[_link_item(link) for link in links]] if links else missing
    if kind == "contact":
        has_github = any(_GITHUB_URL.search(link["url"]) for link in contact)
        return ["", head, "", *[_link_item(link) for link in contact], "- [ADD: 이메일·블로그 주소]" if has_github else "- [ADD: 이메일·GitHub·블로그 주소]"]
    if kind == "toc":
        names = [n for n in (_clean(x) for x in toc) if n]
        return ["", head, "", *[f"{i + 1}. {n}" for i, n in enumerate(names)]] if names else []
    # text
    body = _clean(content["body"] if content else None)
    bullets = [b for b in (_clean(x) for x in (content["bullets"] if content else [])) if b]
    if not body and not bullets:
        return missing
    return ["", head, *(["", body] if body else []), *(["", *[_list_item(b) for b in bullets]] if bullets else [])]


def graph_portfolio_to_markdown(
    out: Mapping[str, Any],
    *,
    title: str,
    person_name: str | None = None,
    links: Mapping[str, Sequence[Mapping[str, str]]] | None = None,
    contact_links: Sequence[Mapping[str, str]] | None = None,
    template_id: str | None = None,
) -> str:
    """TS graphPortfolioToMarkdown — 고른 양식의 구역 순서·제목대로 그린다. 링크는 links(그래프의 주소)로만 붙인다."""
    tpl = get_portfolio_template(template_id)
    link_map = links or {}
    lines: list[str] = [f"# {_clean(title) or '포트폴리오'}"]
    if person_name is not None and js_trim(person_name):
        lines.extend(["", f"**{_clean(person_name)}**"])
    if _clean(out["headline"]):
        lines.extend(["", f"> {_clean(out['headline'])}"])

    projects = out["projects"]
    names = [_clean(p["name"]) or "프로젝트" for p in projects]
    all_links = [{"label": f"{names[i]} · {link['label']}", "url": link["url"]} for i, p in enumerate(projects) for link in link_map.get(p["projectId"], [])]
    top = sections_by_key(out["sections"])
    contact = list(contact_links or [])

    def top_lines(sec: Mapping[str, Any]) -> list[str]:
        return _section_lines(sec, 2, content=top.get(sec["key"]), skills=out["coreSkills"], links=all_links, contact=contact, toc=names, chips=False)

    for sec in tpl["before"]:
        lines.extend(top_lines(sec))

    label = f"{tpl['projectLabel']} " if tpl.get("projectLabel") else ""
    for i, p in enumerate(projects):
        lines.extend(["", "---", "", f"## {label}{i + 1}. {names[i]}"])
        if _clean(p["oneLiner"]):
            lines.extend(["", f"**{_clean(p['oneLiner'])}**"])
        meta = [x for x in (_clean(p["period"]), _clean(p["affiliation"])) if x]
        if meta:
            lines.extend(["", " · ".join(meta)])
        own = sections_by_key(p["sections"])
        for sec in tpl["project"]:
            lines.extend(_section_lines(sec, 3, content=own.get(sec["key"]), skills=p["techStack"], links=link_map.get(p["projectId"], []), contact=contact, toc=[], chips=True))

    after = [line for sec in tpl["after"] for line in top_lines(sec)]
    if after:
        lines.extend(["", "---", *after])
    return js_trim("\n".join(lines)) + "\n"


# ---------------------------------------------------------------------------
# 실패 문구
# ---------------------------------------------------------------------------

TIMEOUT_MESSAGE = "포트폴리오를 만드는 데 시간이 너무 오래 걸려 중단했습니다. 프로젝트 수를 줄여 다시 시도해 주세요."
GENERIC_ERROR = "포트폴리오를 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
STAGE_DEFAULT_ERROR = "이 단계를 실행하는 중 오류가 발생했습니다. 다시 시도해 주세요."

#: TS panel/runner.ts stageErrorMessage의 LlmPermanentError 문구.
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


def graph_portfolio_error_message(err: BaseException) -> str:
    """TS graphPortfolioErrorMessage."""
    if isinstance(err, PortfolioJobError):
        return err.message
    if isinstance(err, LlmPermanentError):
        # JS String.prototype.replace(문자열)는 처음 하나만 바꾼다.
        return f"포트폴리오를 만들지 못했습니다. {_PERMANENT_MESSAGES.get(err.reason, STAGE_DEFAULT_ERROR).replace('이 단계의 ', '', 1)}"
    if isinstance(err, TimeoutError):
        return TIMEOUT_MESSAGE
    return GENERIC_ERROR
