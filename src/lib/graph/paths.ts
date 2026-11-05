/**
 * 본인(Person)에서 각 노드까지의 경로(순수 함수). 그래프에 묻기의 출처 표기("나 → 페이랩(회사) → 백엔드 개발자(직무) → …")와
 * 리랭커의 앵커(가장 가까운 프로젝트·경험) 계산이 함께 쓴다. 설계는 docs/GRAPH-QA.md.
 *
 * - 엣지는 무방향으로 보고 관계 종류별 비용을 둔 Dijkstra(노드 ≤ 1000이라 단순 선택 정렬로 충분).
 * - 동점이면 앞 노드 id 사전순 — 결과가 매번 같다.
 * - 회사 끼워 넣기: 경로에 직무(Role)가 있고 그 직무의 소속 회사가 경로에 없으면 직무 앞에 회사를 넣는다. 직무 없이 프로젝트가
 *   회사·경험·학력에 PART_OF로 붙어 있으면 그 상위 노드를 프로젝트 앞에 넣는다.
 */
import type { GraphPathStep } from "@/lib/domain/chat";
import { type CareerGraph, type GraphNode, type NodeLabel, nodeDisplayName, PERSON_ID, type RelType } from "@/lib/domain/graph";

export type { GraphPathStep };

/** 관계 종류별 이동 비용. 기술은 "쓴 곳"을 거친 경로를 선호한다(HAS_SKILL이 USED_SKILL보다 비싸다). */
export const REL_COST: Record<RelType, number> = {
  HAD_ROLE: 1,
  AT_COMPANY: 1,
  WORKED_ON: 1,
  PART_OF: 1,
  ACHIEVED: 1,
  HAS_EXPERIENCE: 1,
  STUDIED_AT: 1,
  EARNED: 1,
  WORKED_AT: 1.2,
  USED_SKILL: 1.5,
  HAS_SKILL: 1.8,
  RELATED_TO: 2,
};

export const PERSON_NAME = "나";

/** 경로 표시용 짧은 라벨 이름. */
export const SHORT_LABEL: Record<NodeLabel, string> = {
  Company: "회사",
  Role: "직무",
  Project: "프로젝트",
  Experience: "경험",
  Skill: "기술",
  Achievement: "성과",
  Education: "학력",
  Certification: "자격증",
};

/** 경로 단계 → 표시 문자열. 본인은 "나", 나머지는 "이름(라벨)". */
export function stepText(s: GraphPathStep): string {
  return s.label === "Person" ? PERSON_NAME : `${s.name}(${SHORT_LABEL[s.label]})`;
}

/** 경로 → "나 → 페이랩(회사) → …". 본인과 이어지지 않은 노드는 끝에 "(나와 연결되지 않음)". */
export function pathToText(path: readonly GraphPathStep[]): string {
  const connected = path.length < 2 || path.slice(1).every((s) => s.rel !== null);
  if (!connected) return `${PERSON_NAME} ⋯ ${stepText(path.at(-1)!)} (나와 연결되지 않음)`;
  return path.map(stepText).join(" → ");
}

interface Adj {
  to: string;
  type: RelType;
  cost: number;
}

function adjacency(graph: CareerGraph): Map<string, Adj[]> {
  const adj = new Map<string, Adj[]>();
  const push = (a: string, x: Adj) => {
    const list = adj.get(a);
    if (list) list.push(x);
    else adj.set(a, [x]);
  };
  for (const e of graph.edges) {
    const cost = REL_COST[e.type] ?? 2;
    push(e.from, { to: e.to, type: e.type, cost });
    push(e.to, { to: e.from, type: e.type, cost });
  }
  return adj;
}

/** 본인에서의 최단 경로 트리: 노드 id → {거리, 앞 노드, 관계}. */
function shortestTree(graph: CareerGraph): Map<string, { dist: number; prev: string | null; rel: RelType | null }> {
  const adj = adjacency(graph);
  const best = new Map<string, { dist: number; prev: string | null; rel: RelType | null }>([[PERSON_ID, { dist: 0, prev: null, rel: null }]]);
  const done = new Set<string>();
  for (;;) {
    // 아직 확정하지 않은 노드 중 거리 최소(동점이면 id 사전순).
    let cur: string | null = null;
    let curDist = Infinity;
    for (const [id, v] of best) {
      if (done.has(id)) continue;
      if (v.dist < curDist - 1e-9 || (Math.abs(v.dist - curDist) <= 1e-9 && cur !== null && id < cur)) {
        cur = id;
        curDist = v.dist;
      }
    }
    if (cur === null) break;
    done.add(cur);
    for (const a of adj.get(cur) ?? []) {
      if (done.has(a.to)) continue;
      const d = curDist + a.cost;
      const prev = best.get(a.to);
      if (!prev || d < prev.dist - 1e-9 || (Math.abs(d - prev.dist) <= 1e-9 && prev.prev !== null && cur < prev.prev)) {
        best.set(a.to, { dist: d, prev: cur, rel: a.type });
      }
    }
  }
  return best;
}

/** 노드 id → 본인에서 그 노드까지의 경로(첫 단계는 본인). 본인과 이어지지 않은 노드는 [본인, 노드(rel null)]. */
export function personPaths(graph: CareerGraph): Map<string, GraphPathStep[]> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const tree = shortestTree(graph);
  const person: GraphPathStep = { id: PERSON_ID, label: "Person", name: graph.person.name ?? PERSON_NAME, rel: null };
  const step = (n: GraphNode, rel: RelType | null): GraphPathStep => ({ id: n.id, label: n.label, name: nodeDisplayName(n), rel });

  // 직무 → 소속 회사, 프로젝트 → 상위(회사·경험·학력). 여럿이면 id 사전순 첫째.
  const companyOfRole = new Map<string, string>();
  const parentOfProject = new Map<string, string>();
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.type === "AT_COMPANY" && !companyOfRole.has(e.from) && byId.has(e.to)) companyOfRole.set(e.from, e.to);
    if (e.type === "PART_OF" && !parentOfProject.has(e.from) && byId.has(e.to)) parentOfProject.set(e.from, e.to);
  }

  const out = new Map<string, GraphPathStep[]>();
  for (const n of graph.nodes) {
    if (!tree.has(n.id)) {
      out.set(n.id, [person, step(n, null)]);
      continue;
    }
    const ids: { id: string; rel: RelType | null }[] = [];
    for (let cur: string | null = n.id; cur !== null && cur !== PERSON_ID; cur = tree.get(cur)?.prev ?? null) {
      ids.push({ id: cur, rel: tree.get(cur)!.rel });
    }
    ids.reverse();
    const inPath = new Set(ids.map((x) => x.id));
    const hasRole = ids.some((x) => byId.get(x.id)?.label === "Role");
    const steps: GraphPathStep[] = [person];
    for (const [i, x] of ids.entries()) {
      const node = byId.get(x.id)!;
      let rel = x.rel;
      // 직무 앞에 소속 회사.
      const company = node.label === "Role" ? companyOfRole.get(node.id) : undefined;
      if (company && !inPath.has(company) && i === 0) {
        steps.push(step(byId.get(company)!, "WORKED_AT"));
        inPath.add(company);
        rel = "AT_COMPANY";
      }
      // 직무 없는 경로의 프로젝트 앞에 상위 노드(회사·경험·학력).
      const parent = node.label === "Project" && !hasRole ? parentOfProject.get(node.id) : undefined;
      if (parent && !inPath.has(parent) && i === 0) {
        const p = byId.get(parent)!;
        const parentRel: RelType = p.label === "Company" ? "WORKED_AT" : p.label === "Experience" ? "HAS_EXPERIENCE" : "STUDIED_AT";
        steps.push(step(p, parentRel));
        inPath.add(parent);
        rel = "PART_OF";
      }
      steps.push(step(node, rel));
    }
    out.set(n.id, steps);
  }
  return out;
}

/**
 * 앵커: 경로에서 노드에 가장 가까운 프로젝트·경험(노드 자신 포함), 없으면 직무, 그것도 없으면 노드 자신.
 * 리랭커의 MMR이 "같은 프로젝트에서 나온 항목"을 묶는 기준이다.
 */
export function anchorOf(nodeId: string, path: readonly GraphPathStep[] | undefined): string {
  if (!path) return nodeId;
  const rev = [...path].reverse();
  return (
    rev.find((s) => s.label === "Project" || s.label === "Experience")?.id ?? rev.find((s) => s.label === "Role")?.id ?? nodeId
  );
}
