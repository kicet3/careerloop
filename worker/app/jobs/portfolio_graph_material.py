"""경험 그래프 포트폴리오 자료 모으기 — TS src/lib/portfolios/graph-material.ts loadOwnGraph·assertProjectsInGraph·findOwnPosting·
loadPortfolioMaterial·projectText와 src/lib/graph/project-structure.ts projectSubgraph를 옮긴 것.

사용자 간 격리(가장 중요한 규칙, 코드로 강제한다):
- user_id는 호출자가 DB 작업 행에서 읽은 값만 받는다(요청 본문 값 금지).
- 그래프는 그 사용자의 것만 읽고(get_career_graph(user_id)) 프롬프트에 넣기 전에 assert_graph_owner로 다시 확인한다.
- 고른 프로젝트 id는 그 그래프의 Project 노드여야 한다. 다른 사용자의 노드 id(또는 지워진 id)면 400으로 실패하고 아무것도 프롬프트에 넣지 않는다.
- 공고·GitHub 저장소·GitHub 계정은 모두 user_id 조건으로만 읽는다. 링크는 AI가 쓰지 않고 그래프 Project.url과 이 사용자가 연결한 공개 저장소로만 붙인다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from app.graph import CareerGraph, GraphEdge, GraphNode, assert_graph_owner, get_career_graph, graph_to_text
from app.graph.domain import NODE_TITLE_KEY, PERSON_ID, node_display_name
from app.jobs.base import WorkerContext
from app.jobs.portfolio_graph_output import PortfolioJobError
from app.jsutil import js_collapse_ws, js_len, js_slice, js_string, js_trim

GRAPH_DISABLED_MESSAGE = "경험 그래프 저장소(Neo4j)가 설정되지 않아 경험 그래프로 포트폴리오를 만들 수 없습니다."
GRAPH_EMPTY_MESSAGE = "경험 그래프에 프로젝트가 없습니다. '경험 그래프'에서 프로젝트를 먼저 정리해 주세요."
UNKNOWN_PROJECT_MESSAGE = "고른 프로젝트 중 내 경험 그래프에 없는 항목이 있습니다. 화면을 새로고침한 뒤 다시 골라 주세요."

#: 프롬프트에 넣는 그래프 자료 전체 상한(글자). 프로젝트 수로 나눠 쓴다(TS와 같은 값).
MATERIAL_MAX_CHARS = 48_000
PER_PROJECT_MIN = 3_000
PER_PROJECT_MAX = 9_000
PROJECT_PROP_CAPS = (1000, 400, 200, 60, 0)

_HTTP_URL = re.compile(r"^https?://", re.IGNORECASE | re.ASCII)
_GITHUB_HTTPS = re.compile(r"^https://github\.com/")
_GITHUB_LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})")


@dataclass(frozen=True)
class PortfolioProjectMaterial:
    id: str
    name: str
    #: 프롬프트에 넣는 이 프로젝트의 그래프 텍스트(속성 + 주변 그래프).
    text: str


@dataclass(frozen=True)
class OwnPosting:
    id: str
    company: str
    role_title: str
    jd_text: str


@dataclass
class PortfolioMaterial:
    person_name: str | None
    projects: list[PortfolioProjectMaterial]
    #: 프로젝트 id → 그래프에 있는 주소(Project.url, 공개 GitHub 저장소). [{label, url}]
    links: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    #: 연락처 구역에 붙이는 사용자 본인의 주소(연결한 GitHub 계정 프로필).
    contact_links: list[dict[str, str]] = field(default_factory=list)
    posting: OwnPosting | None = None


def _str(v: Any) -> str:
    return js_trim(v) if isinstance(v, str) else ""


def per_project_max_chars(count: int) -> int:
    """TS perProjectMaxChars."""
    return max(PER_PROJECT_MIN, min(PER_PROJECT_MAX, MATERIAL_MAX_CHARS // count))


def assert_projects_in_graph(graph: CareerGraph, project_ids: list[str]) -> None:
    """고른 id가 모두 이 그래프의 Project 노드인지. 하나라도 아니면 400(다른 사용자의 id·지워진 id), 프로젝트가 없으면 409."""
    projects = {n.id for n in graph.nodes if n.label == "Project"}
    if not projects:
        raise PortfolioJobError(GRAPH_EMPTY_MESSAGE, 409)
    if not project_ids or any(pid not in projects for pid in project_ids):
        raise PortfolioJobError(UNKNOWN_PROJECT_MESSAGE, 400)


def _related_experience_ids(graph: CareerGraph, project_id: str) -> set[str]:
    labels = {n.id: n.label for n in graph.nodes}
    return {e.from_ for e in graph.edges if e.type == "RELATED_TO" and e.to == project_id and labels.get(e.from_) == "Experience"}


def project_subgraph(graph: CareerGraph, project_id: str) -> CareerGraph | None:
    """TS projectSubgraph: 프로젝트와 바로 이어진 노드, Role의 회사, 관련 Experience의 기술·성과. 소유자 표시 없는 새 객체."""
    project = next((n for n in graph.nodes if n.id == project_id), None)
    if project is None or project.label != "Project":
        return None
    labels = {n.id: n.label for n in graph.nodes}
    scope: set[str] = {project_id}
    for e in graph.edges:
        if e.from_ == project_id and e.to != PERSON_ID:
            scope.add(e.to)
        if e.to == project_id and e.from_ != PERSON_ID:
            scope.add(e.from_)
    experiences = _related_experience_ids(graph, project_id)
    for e in graph.edges:
        if e.from_ not in scope or e.from_ == project_id:
            continue
        if labels.get(e.from_) == "Role" and e.type == "AT_COMPANY":
            scope.add(e.to)
        if e.from_ in experiences and e.type in ("USED_SKILL", "ACHIEVED"):
            scope.add(e.to)
    nodes: list[GraphNode] = [n for n in graph.nodes if n.id in scope]
    edges: list[GraphEdge] = [e for e in graph.edges if e.to in scope and (e.from_ in scope or e.from_ == PERSON_ID)]
    return CareerGraph(person=graph.person, nodes=nodes, edges=edges)


def _prop_value(v: Any) -> str:
    return "|".join("" if x is None else js_string(x) for x in v) if isinstance(v, list) else js_string(v)


def project_text(graph: CareerGraph, project_id: str, max_chars: int) -> str:
    """TS projectText — 속성 원문(1200자까지) + 주변 그래프 요약."""
    project = next(n for n in graph.nodes if n.id == project_id)
    title_key = NODE_TITLE_KEY["Project"]
    own = [
        f"- {k}: {js_slice(js_collapse_ws(_prop_value(v)), 0, 1200)}"
        for k, v in project.props.items()
        if k != title_key and v is not None and v != ""
    ]
    sub = project_subgraph(graph, project_id)
    assert sub is not None
    around = graph_to_text(sub, max_chars=max(1000, max_chars - js_len("\n".join(own)) - 200), prop_caps=PROJECT_PROP_CAPS)
    return "\n".join([f"프로젝트 [{project_id}] {node_display_name(project)}", "속성:", *(own or ["- (없음)"]), "주변 그래프:", around])


async def load_own_graph(ctx: WorkerContext, user_id: str, person_name: str | None) -> CareerGraph:
    """요청 사용자의 그래프(소유자 확인까지). 저장소가 없으면 503."""
    if not ctx.graph.enabled:
        raise PortfolioJobError(GRAPH_DISABLED_MESSAGE, 503)
    return assert_graph_owner(await get_career_graph(ctx.graph, user_id, person_name), user_id)


_POSTING_SQL = "SELECT id, company, role_title, jd_text FROM job_postings WHERE id = %(id)s AND user_id = %(user_id)s LIMIT 1"
_REPOS_SQL = (
    "SELECT project_node_id, html_url, full_name FROM github_repo_snapshots "
    "WHERE user_id = %(user_id)s AND private = false AND project_node_id = ANY(%(ids)s)"
)
_GITHUB_ACCOUNT_SQL = "SELECT login FROM github_accounts WHERE user_id = %(user_id)s"


async def find_own_posting(ctx: WorkerContext, user_id: str, posting_id: str) -> OwnPosting | None:
    """강조할 공고(이 사용자의 공고 보관함). 없으면 None."""
    row = await ctx.db.fetchone(_POSTING_SQL, {"id": posting_id, "user_id": user_id})
    if not row:
        return None
    return OwnPosting(id=row["id"], company=row["company"], role_title=row["role_title"], jd_text=row["jd_text"] or "")


async def load_portfolio_material(ctx: WorkerContext, user_id: str, user_name: str | None, input_: dict[str, Any]) -> PortfolioMaterial:
    """TS loadPortfolioMaterial: 이 사용자의 그래프에서 고른 프로젝트만(고른 순서). 공고는 이 사용자의 것만(없어졌으면 공고 없이)."""
    project_ids: list[str] = input_["projectIds"]
    graph = await load_own_graph(ctx, user_id, user_name)
    assert_projects_in_graph(graph, project_ids)
    per = per_project_max_chars(len(project_ids))
    by_id = {n.id: n for n in graph.nodes}
    projects = [PortfolioProjectMaterial(id=pid, name=node_display_name(by_id[pid]), text=project_text(graph, pid, per)) for pid in project_ids]

    links: dict[str, list[dict[str, str]]] = {}

    def add(pid: str, link: dict[str, str]) -> None:
        lst = links.setdefault(pid, [])
        if not any(x["url"] == link["url"] for x in lst):
            lst.append(link)

    for p in projects:
        url = _str(by_id[p.id].props.get("url"))
        if _HTTP_URL.search(url):
            add(p.id, {"label": "GitHub" if "github.com" in url else "프로젝트 링크", "url": url})
    # 이 사용자가 프로젝트에 연결한 GitHub 저장소(비공개 저장소는 남이 열 수 없으므로 붙이지 않는다).
    for r in await ctx.db.fetchall(_REPOS_SQL, {"user_id": user_id, "ids": list(project_ids)}):
        if r.get("project_node_id") and _GITHUB_HTTPS.search(r["html_url"]):
            add(r["project_node_id"], {"label": f"GitHub · {r['full_name']}", "url": r["html_url"]})

    # 연락처: 이 사용자 자신이 연결한 GitHub 계정의 프로필 주소만(이메일 등 계정 정보는 본문에 넣지 않는다).
    gh = await ctx.db.fetchone(_GITHUB_ACCOUNT_SQL, {"user_id": user_id})
    login = gh.get("login") if gh else None
    contact = [{"label": f"GitHub · {login}", "url": f"https://github.com/{login}"}] if isinstance(login, str) and _GITHUB_LOGIN.fullmatch(login) else []

    posting = await find_own_posting(ctx, user_id, input_["postingId"]) if input_.get("postingId") else None
    name = js_trim(user_name) if user_name else ""
    return PortfolioMaterial(person_name=name or None, projects=projects, links=links, contact_links=contact, posting=posting)
