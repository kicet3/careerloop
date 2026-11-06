/**
 * 프로젝트 단위 그래프 채팅(순수, 클라이언트·서버 공용): Project 노드 하나를 얼마나 구조화했는지 판정하고(7개 항목),
 * 그 프로젝트의 주변 그래프를 프롬프트용으로 잘라 내며, 대화 변경안이 이 프로젝트에 붙는 연산만 남도록 거른다.
 *
 * 항목은 domain/graph.ts의 기존 라벨·관계·속성으로만 판정한다(새 속성을 만들지 않는다):
 * - 배경·문제: Project.situation(없으면 summary)
 * - 내 역할: Project.myRole
 * - 한 일: Project.action, 또는 이 프로젝트의 일화(Experience -RELATED_TO-> 프로젝트)의 action·description
 * - 사용 기술: Project -USED_SKILL-> Skill
 * - 성과: Project.result의 수치, 또는 Project(또는 그 일화 Experience) -ACHIEVED-> Achievement의 수치
 * - 기간·소속: Project.startDate + (Role -WORKED_ON-> Project 또는 Project -PART_OF-> Company|Experience|Education)
 * - 배운 점: Project.learned
 * 프로젝트 -PART_OF-> Experience(그 프로젝트가 속한 동아리·프로그램)는 소속으로만 센다 — 그 경험의 설명·성과는 이 프로젝트의 것이 아니다.
 */
import {
  type CareerGraph,
  describeGraphOp,
  type GraphNode,
  type GraphOp,
  nodeDisplayName,
  NODE_TITLE_KEY,
  PERSON_ID,
} from "@/lib/domain/graph";
import { filled, hasMetric } from "./completeness";
import { graphToText } from "./text";

export const PROJECT_STRUCTURE_ITEM_IDS = ["background", "role", "actions", "skills", "results", "context", "learned"] as const;
export type ProjectStructureItemId = (typeof PROJECT_STRUCTURE_ITEM_IDS)[number];

export interface ProjectStructureItemDef {
  id: ProjectStructureItemId;
  name: string;
  /** AI가 이 항목을 채우려고 물을 질문(한 번에 하나). */
  question: string;
  /** 답을 넣을 곳(프롬프트 안내). */
  target: string;
}

/** 순서가 곧 우선순위다: 빠진 항목 중 앞의 것부터 묻는다. */
export const PROJECT_STRUCTURE_ITEMS: readonly ProjectStructureItemDef[] = [
  {
    id: "background",
    name: "배경·문제",
    question: "이 프로젝트는 어떤 상황·문제에서 시작됐고, 목표는 무엇이었나요?",
    target: "Project.situation(상황·문제·목표), 한 줄 설명은 Project.summary",
  },
  {
    id: "role",
    name: "내 역할",
    question: "이 프로젝트에서 맡은 역할과 책임 범위는 무엇이었나요? 팀은 몇 명이었나요?",
    target: "Project.myRole, 팀 규모는 Project.teamSize",
  },
  {
    id: "actions",
    name: "한 일",
    question: "직접 한 일을 구체적으로 알려 주세요. 어떤 방법을 왜 골랐나요?",
    target: "Project.action. 따로 떼어 낼 만한 일화는 Experience로 만들어 Experience -RELATED_TO-> 이 프로젝트, me -HAS_EXPERIENCE-> Experience",
  },
  {
    id: "skills",
    name: "사용 기술",
    question: "어떤 기술·도구를 썼고, 각각 어디에 썼나요?",
    target: "이 프로젝트 -USED_SKILL-> Skill(이미 있는 기술이면 그 [id]로 연결)",
  },
  {
    id: "results",
    name: "성과",
    question: "결과는 어땠나요? 전후 수치(%, 시간, 건수, 금액 등)로 말할 수 있나요?",
    target: "Project.result, 수치 성과는 Achievement(value에 수치)를 만들어 이 프로젝트 -ACHIEVED-> Achievement",
  },
  {
    id: "context",
    name: "기간·소속",
    question: "언제부터 언제까지 했고, 어느 회사·직무(또는 동아리·학교)에서 한 프로젝트인가요?",
    target: "Project.startDate·endDate, 소속은 Role -WORKED_ON-> 이 프로젝트 또는 이 프로젝트 -PART_OF-> Company|Experience|Education",
  },
  {
    id: "learned",
    name: "배운 점",
    question: "이 프로젝트로 무엇을 배웠고, 이후 일하는 방식이 어떻게 달라졌나요?",
    target: "Project.learned",
  },
];

export type ProjectItemState = "missing" | "partial" | "done";

export interface ProjectStructureItem {
  id: ProjectStructureItemId;
  name: string;
  state: ProjectItemState;
  /** 한 줄 안내. 예: "수치가 없어요" */
  hint: string;
}

export interface ProjectStructure {
  projectId: string;
  projectName: string;
  items: ProjectStructureItem[];
  /** done인 항목 수. */
  done: number;
  total: number;
  /** 다음에 물을 항목(완료가 아닌 첫 항목). 모두 채웠으면 null. */
  next: ProjectStructureItemId | null;
}

const present = (v: unknown) => typeof v === "string" && v.trim() !== "";
const propsOf = (n: GraphNode) => n.props as Record<string, unknown>;

/**
 * 이 프로젝트의 일화(Experience -RELATED_TO-> 프로젝트). 프로젝트 -PART_OF-> Experience(프로젝트가 속한 동아리·프로그램)는
 * 넣지 않는다 — 그건 소속이지 이 프로젝트의 내용이 아니다(기간·소속 항목에서만 센다).
 */
function relatedExperienceIds(graph: CareerGraph, projectId: string): Set<string> {
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const ids = new Set<string>();
  for (const e of graph.edges) {
    if (e.type === "RELATED_TO" && e.to === projectId && labels.get(e.from) === "Experience") ids.add(e.from);
  }
  return ids;
}

function findProject(graph: CareerGraph, projectId: string): GraphNode | null {
  const n = graph.nodes.find((x) => x.id === projectId);
  return n && n.label === "Project" ? n : null;
}

/** 프로젝트 구조화 판정. 프로젝트가 없으면(지워졌거나 Project가 아니면) null. */
export function assessProjectStructure(graph: CareerGraph, projectId: string): ProjectStructure | null {
  const project = findProject(graph, projectId);
  if (!project) return null;
  const p = propsOf(project);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const experiences = [...relatedExperienceIds(graph, projectId)].map((id) => byId.get(id)!).filter(Boolean);
  const out = graph.edges.filter((e) => e.from === projectId);
  const into = graph.edges.filter((e) => e.to === projectId);

  const states: Record<ProjectStructureItemId, [ProjectItemState, string]> = {
    background: filled(p.situation) || filled(p.summary)
      ? ["done", "배경을 적었어요"]
      : present(p.situation) || present(p.summary)
        ? ["partial", "배경 설명이 너무 짧아요"]
        : ["missing", "어떤 문제에서 시작했는지 없어요"],
    role: present(p.myRole) ? ["done", `${String(p.myRole)}`] : ["missing", "맡은 역할이 없어요"],
    actions:
      filled(p.action) || experiences.some((x) => filled(propsOf(x).action) || filled(propsOf(x).description))
        ? ["done", "한 일을 적었어요"]
        : present(p.action)
          ? ["partial", "한 일이 너무 짧아요"]
          : ["missing", "직접 한 일이 없어요"],
    skills: (() => {
      const n = out.filter((e) => e.type === "USED_SKILL").length;
      return n > 0 ? (["done", `기술 ${n}개 연결`] as [ProjectItemState, string]) : (["missing", "연결된 기술이 없어요"] as [ProjectItemState, string]);
    })(),
    results: (() => {
      const sources = new Set([projectId, ...experiences.map((x) => x.id)]);
      const achievements = graph.edges
        .filter((e) => e.type === "ACHIEVED" && sources.has(e.from))
        .map((e) => byId.get(e.to))
        .filter((n): n is GraphNode => n?.label === "Achievement");
      const metricAch = achievements.some((a) => hasMetric(String(propsOf(a).value ?? "")) || hasMetric(String(propsOf(a).summary ?? "")));
      if (hasMetric(String(p.result ?? "")) || metricAch) return ["done", "수치가 있는 성과가 있어요"];
      if (present(p.result) || achievements.length > 0) return ["partial", "성과에 수치가 없어요"];
      return ["missing", "결과·성과가 없어요"];
    })(),
    context: (() => {
      const period = present(p.startDate);
      const affiliation =
        into.some((e) => e.type === "WORKED_ON" && byId.get(e.from)?.label === "Role") || out.some((e) => e.type === "PART_OF");
      if (period && affiliation) return ["done", "기간과 소속이 있어요"];
      if (period) return ["partial", "어느 회사·직무(또는 동아리·학교)에서 했는지 없어요"];
      if (affiliation) return ["partial", "기간(시작일)이 없어요"];
      return ["missing", "기간과 소속이 없어요"];
    })(),
    learned: filled(p.learned)
      ? ["done", "배운 점을 적었어요"]
      : present(p.learned)
        ? ["partial", "배운 점이 너무 짧아요"]
        : ["missing", "배운 점이 없어요"],
  };

  const items: ProjectStructureItem[] = PROJECT_STRUCTURE_ITEMS.map((def) => ({
    id: def.id,
    name: def.name,
    state: states[def.id][0],
    hint: states[def.id][1],
  }));
  return {
    projectId,
    projectName: nodeDisplayName(project),
    items,
    done: items.filter((i) => i.state === "done").length,
    total: items.length,
    next: items.find((i) => i.state !== "done")?.id ?? null,
  };
}

/**
 * 프로젝트 주변 그래프: 프로젝트, 이웃 노드(본인 제외), 그리고 한 단계 더 — 이웃 Role의 회사(AT_COMPANY), 이 프로젝트의 일화
 * (Experience -RELATED_TO-> 프로젝트)의 기술·성과(USED_SKILL·ACHIEVED). 프로젝트가 속한 Experience(PART_OF)는 이웃으로만 넣고 넓히지 않는다. 기술·회사처럼 여러 경험이 함께 쓰는 노드에서는 더 퍼지지 않는다(다른 프로젝트가 끼지 않게).
 * 관계는 범위 안 노드끼리, 그리고 본인 → 범위 안 노드만 남긴다. 프로젝트가 없으면 null.
 */
export function projectSubgraph(graph: CareerGraph, projectId: string): CareerGraph | null {
  if (!findProject(graph, projectId)) return null;
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const scope = new Set<string>([projectId]);
  for (const e of graph.edges) {
    if (e.from === projectId && e.to !== PERSON_ID) scope.add(e.to);
    if (e.to === projectId && e.from !== PERSON_ID) scope.add(e.from);
  }
  const experiences = relatedExperienceIds(graph, projectId);
  for (const e of graph.edges) {
    if (!scope.has(e.from) || e.from === projectId) continue;
    if (labels.get(e.from) === "Role" && e.type === "AT_COMPANY") scope.add(e.to);
    if (experiences.has(e.from) && (e.type === "USED_SKILL" || e.type === "ACHIEVED")) scope.add(e.to);
  }
  return {
    person: graph.person,
    nodes: graph.nodes.filter((n) => scope.has(n.id)),
    edges: graph.edges.filter((e) => scope.has(e.to) && (scope.has(e.from) || e.from === PERSON_ID)),
  };
}

const STATE_NAMES: Record<ProjectItemState, string> = { missing: "없음", partial: "일부", done: "완료" };

/** 프로젝트 주변 그래프 텍스트 상한(글자). 속성은 전체 그래프 요약보다 길게 남긴다. */
const FOCUS_TEXT_MAX_CHARS = 8000;
const FOCUS_PROP_CAPS = [1000, 400, 200, 60, 0] as const;

/** 구조화 체크리스트 텍스트(프롬프트용). */
export function projectStructureToPromptText(s: ProjectStructure): string {
  const next = s.next ? PROJECT_STRUCTURE_ITEMS.find((d) => d.id === s.next)!.name : "없음(모두 채움)";
  const lines = s.items.map((item) => {
    const def = PROJECT_STRUCTURE_ITEMS.find((d) => d.id === item.id)!;
    const head = `- [${STATE_NAMES[item.state]}] ${item.id}(${item.name}): ${item.hint}`;
    return item.state === "done" ? head : `${head}. 물을 질문: ${def.question} 넣을 곳: ${def.target}`;
  });
  return [`구조화 ${s.done}/${s.total} 완료 · 다음에 물을 항목: ${next}`, ...lines].join("\n");
}

/**
 * 프로젝트 단위 대화 프롬프트 블록: 구조화할 프로젝트, 주변 그래프, 구조화 체크리스트. 호출자가 wrapData로 감싼다(노드 이름은 사용자 입력이다).
 * 프로젝트가 없으면 null.
 */
export function projectFocusText(graph: CareerGraph, projectId: string): string | null {
  const sub = projectSubgraph(graph, projectId);
  const structure = assessProjectStructure(graph, projectId);
  if (!sub || !structure) return null;
  const project = findProject(graph, projectId)!;
  const titleKey = NODE_TITLE_KEY.Project;
  const ownProps = Object.entries(propsOf(project))
    .filter(([k, v]) => k !== titleKey && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `- ${k}: ${(Array.isArray(v) ? v.join("|") : String(v)).replace(/\s+/g, " ")}`);
  return [
    `구조화할 프로젝트: [${projectId}] ${structure.projectName}`,
    "",
    "이 프로젝트의 현재 속성(원문 그대로, 자르지 않음 — 기존 값에 더해 다시 쓸 때는 이 값을 기준으로 한다):",
    ...(ownProps.length ? ownProps : ["- (아직 없음)"]),
    "",
    "프로젝트 주변 그래프(이 프로젝트와 직접·한 단계 건너 이어진 항목):",
    graphToText(sub, { maxChars: FOCUS_TEXT_MAX_CHARS, propCaps: FOCUS_PROP_CAPS }),
    "",
    "프로젝트 구조화 체크리스트:",
    projectStructureToPromptText(structure),
  ].join("\n");
}

/**
 * 프로젝트 단위 대화의 변경안 범위 검사: 이 프로젝트에 붙는 연산만 남긴다(나머지는 사유와 함께 뺀다). 형식·관계 방향 검사는
 * 하지 않는다(validateAgainstGraph가 한다).
 *
 * - 범위(scope) = projectSubgraph의 노드. 기준점(anchor) = 프로젝트, 이 프로젝트의 일화(Experience -RELATED_TO-> 프로젝트), 그리고 같은
 *   변경안의 관계로 기준점에 이어진 새 노드(사슬도 된다: 프로젝트 → 새 경험 → 새 성과). 본인·기술·회사·소속 경험은 기준점이 아니다.
 * - addNode: 기준점이 된 새 노드만. 새 Project는 만들지 않는다.
 * - addEdge·deleteEdge: 한쪽이 이 프로젝트면 된다(기존 기술·직무·일화를 이 프로젝트에 잇기). 한쪽이 다른 기준점(일화·새 노드)이면 다른 쪽은
 *   범위 안·기준점·본인이거나 기존 Skill이어야 한다(무관한 직무·프로젝트가 새 노드에 붙지 않게). 기준점이 없으면 양쪽이 모두 범위 안.
 * - updateNode: 범위 안 노드, 또는 같은 변경안의 관계로 이 프로젝트에 바로 이어진 기존 노드.
 * - deleteNode: 이 프로젝트에만 딸린 노드만(이 프로젝트 자체는 안 된다). 본인을 뺀 모든 관계가 이 프로젝트·그 일화와의 관계이거나,
 *   일화에서 기술·성과로 나가는 관계여야 한다. 여러 경험이 함께 쓰는 직무·회사·기술은 지우지 않고 관계만 끊는다(deleteEdge).
 * 프로젝트가 없으면 연산을 모두 뺀다.
 */
export function restrictToFocus(
  ops: readonly GraphOp[],
  graph: CareerGraph,
  projectId: string,
): { ops: GraphOp[]; dropped: string[] } {
  const sub = projectSubgraph(graph, projectId);
  const describe = (op: GraphOp) => describeGraphOp(op, graph, ops);
  if (!sub) return { ops: [], dropped: ops.map((op) => `${describe(op)} — 구조화하던 프로젝트를 찾을 수 없습니다`) };
  const scope = new Set(sub.nodes.map((n) => n.id));
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const newLabels = new Map(ops.flatMap((op) => (op.op === "addNode" ? [[op.ref, op.label] as const] : [])));
  const episodes = relatedExperienceIds(graph, projectId);
  const anchors = new Set<string>([projectId, ...episodes]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const op of ops) {
      if (op.op !== "addEdge") continue;
      for (const [a, b] of [
        [op.from, op.to],
        [op.to, op.from],
      ] as const) {
        if (anchors.has(a) && !anchors.has(b) && newLabels.has(b) && newLabels.get(b) !== "Project") {
          anchors.add(b);
          changed = true;
        }
      }
    }
  }
  const inScope = (id: string) => scope.has(id) || anchors.has(id) || id === PERSON_ID;
  const edgeOk = (from: string, to: string) => {
    if (from === to) return false;
    if (from === projectId || to === projectId) return true;
    const otherOk = (id: string) => inScope(id) || labels.get(id) === "Skill";
    if (anchors.has(from)) return otherOk(to);
    if (anchors.has(to)) return otherOk(from);
    return inScope(from) && inScope(to);
  };
  const linked = new Set<string>();
  for (const op of ops) {
    if (op.op !== "addEdge" || !edgeOk(op.from, op.to)) continue;
    if (op.from === projectId) linked.add(op.to);
    if (op.to === projectId) linked.add(op.from);
  }
  const owners = new Set<string>([projectId, ...episodes]);
  const ownedByProject = (id: string) =>
    graph.edges.every((e) => {
      if (e.from !== id && e.to !== id) return true;
      const other = e.from === id ? e.to : e.from;
      if (other === PERSON_ID || owners.has(other)) return true;
      return episodes.has(id) && e.from === id && (e.type === "USED_SKILL" || e.type === "ACHIEVED");
    });

  const kept: GraphOp[] = [];
  const dropped: string[] = [];
  const drop = (op: GraphOp, reason: string) => dropped.push(`${describe(op)} — ${reason}`);
  for (const op of ops) {
    switch (op.op) {
      case "addNode":
        if (op.label === "Project") drop(op, "프로젝트 대화에서는 새 프로젝트를 만들지 않습니다(일반 대화에서 추가해 주세요)");
        else if (anchors.has(op.ref)) kept.push(op);
        else drop(op, "이 프로젝트와 연결되지 않아 뺐습니다");
        break;
      case "updateNode":
        if (scope.has(op.id) || linked.has(op.id)) kept.push(op);
        else drop(op, "이 프로젝트와 관련 없는 항목이라 뺐습니다");
        break;
      case "deleteNode":
        if (op.id === projectId) drop(op, "구조화 중인 프로젝트 자체는 이 대화에서 지우지 않습니다");
        else if (!scope.has(op.id)) drop(op, "이 프로젝트와 관련 없는 항목이라 뺐습니다");
        else if (!ownedByProject(op.id))
          drop(op, "다른 경험과도 이어진 항목이라 지우지 않습니다(이 프로젝트와의 연결만 끊으려면 연결 삭제로 요청해 주세요)");
        else kept.push(op);
        break;
      case "addEdge":
      case "deleteEdge":
        if (edgeOk(op.from, op.to)) kept.push(op);
        else drop(op, "이 프로젝트와 관련 없는 연결이라 뺐습니다");
        break;
    }
  }
  return { ops: kept, dropped };
}
