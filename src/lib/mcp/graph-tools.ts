/**
 * MCP 도구의 본문(순수 함수, 전송 방식과 무관). 입력은 이미 검증된 인자와 그 사용자의 경험 그래프 하나이고, 출력은 JSON 값이다.
 * LLM을 부르지 않는다 — 검색은 그래프에 묻기의 결정적 단계(retrieve → rerank)만 쓴다(docs/GRAPH-QA.md).
 * 노출하는 값: 화이트리스트 속성(domain/graph.ts NODE_PROP_SCHEMAS), 노드·관계 id, 사용자 이름. 이메일·다른 테이블은 넣지 않는다.
 */
import {
  allowedPropKeys,
  type CareerGraph,
  type GraphNode,
  MAX_NODES_PER_USER,
  NODE_LABEL_META,
  NODE_LABELS,
  NODE_PROP_SCHEMAS,
  NODE_TITLE_KEY,
  type NodeLabel,
  nodeDisplayName,
  PERSON_ID,
  REL_RULES,
  REL_TYPES,
  type RelType,
  STORY_TAGS,
} from "@/lib/domain/graph";
import { experienceCategory, storyTagName } from "@/lib/domain/experience-categories";
import { assessExperienceChecklist, checklistToPromptText } from "@/lib/graph/completeness";
import { personPaths, pathToText, PERSON_NAME } from "@/lib/graph/paths";
import { graphOverview, snippetOf } from "@/lib/graph/qa-context";
import { answerK, MIN_K, rerank } from "@/lib/graph/rerank";
import { retrieve } from "@/lib/graph/retrieve";
import { graphToText } from "@/lib/graph/text";

/** 사용자에게 그대로 보여도 되는 도구 오류(isError 결과의 문구). */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export const EMPTY_GRAPH_OVERVIEW = "(아직 정리된 경력·경험이 없다)";
export const PERSON_LABEL_NAME = "본인";

export const LIST_NODES_DEFAULT_LIMIT = 50;
export const LIST_NODES_MAX_LIMIT = 100;
export const NEIGHBOR_DEFAULT_LIMIT = 50;
export const NEIGHBOR_MAX_LIMIT = 200;
export const SEARCH_MAX_LIMIT = 20;
export const GRAPH_TEXT_DEFAULT_CHARS = 12_000;
export const GRAPH_TEXT_MIN_CHARS = 1_000;
export const GRAPH_TEXT_MAX_CHARS = 30_000;
export const TOP_SKILLS_MAX = 15;

export interface NodeSummary {
  id: string;
  label: NodeLabel | "Person";
  labelName: string;
  name: string;
  /** 마지막 수정 시각(ISO 8601). 본인·기록 없음이면 null. */
  updatedAt: string | null;
}

const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

export function nodeSummary(n: GraphNode): NodeSummary {
  return { id: n.id, label: n.label, labelName: NODE_LABEL_META[n.label].name, name: nodeDisplayName(n), updatedAt: iso(n.updatedAt) };
}

function personSummary(graph: CareerGraph): NodeSummary {
  return { id: PERSON_ID, label: "Person", labelName: PERSON_LABEL_NAME, name: graph.person.name ?? PERSON_NAME, updatedAt: null };
}

/** 화이트리스트 속성만(저장소가 이미 거르지만 한 번 더). */
function nodeProps(n: GraphNode): Record<string, unknown> {
  const raw = n.props as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of allowedPropKeys(n.label)) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ---------------------------------------------------------------------------
// get_profile_summary
// ---------------------------------------------------------------------------

export function profileSummary(graph: CareerGraph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const counts = Object.fromEntries(NODE_LABELS.map((l) => [l, 0])) as Record<NodeLabel, number>;
  for (const n of graph.nodes) counts[n.label] += 1;

  const companyOf = new Map<string, GraphNode>();
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const to = byId.get(e.to);
    if (e.type === "AT_COMPANY" && to && !companyOf.has(e.from)) companyOf.set(e.from, to);
  }
  const currentRoles = graph.nodes
    .filter((n) => n.label === "Role" && (n.props as Record<string, unknown>).current === true)
    .map((n) => {
      const p = n.props as Record<string, unknown>;
      const company = companyOf.get(n.id);
      return {
        id: n.id,
        title: nodeDisplayName(n),
        company: company ? { id: company.id, name: nodeDisplayName(company) } : null,
        startDate: str(p.startDate),
      };
    });

  const companies = graph.nodes.filter((n) => n.label === "Company").map(nodeSummary);
  const education = graph.nodes
    .filter((n) => n.label === "Education")
    .map((n) => {
      const p = n.props as Record<string, unknown>;
      return { id: n.id, school: nodeDisplayName(n), degree: str(p.degree), major: str(p.major), status: str(p.status) };
    });

  const uses = new Map<string, number>();
  for (const e of graph.edges) if (e.type === "USED_SKILL" || e.type === "HAS_SKILL") uses.set(e.to, (uses.get(e.to) ?? 0) + 1);
  const topSkills = graph.nodes
    .filter((n) => n.label === "Skill")
    .map((n) => ({ id: n.id, name: nodeDisplayName(n), uses: uses.get(n.id) ?? 0 }))
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, TOP_SKILLS_MAX);

  const checklist = assessExperienceChecklist(graph);
  const lastUpdated = Math.max(0, ...graph.nodes.map((n) => n.updatedAt));
  return {
    personName: graph.person.name,
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    counts,
    currentRoles,
    companies,
    education,
    topSkills,
    checklist: {
      progress: checklist.progress,
      requiredDone: checklist.requiredDone,
      requiredTotal: checklist.requiredTotal,
      complete: checklist.complete,
    },
    lastUpdatedAt: iso(lastUpdated),
    overview: graph.nodes.length === 0 ? EMPTY_GRAPH_OVERVIEW : graphOverview(graph, checklist),
  };
}

// ---------------------------------------------------------------------------
// list_nodes
// ---------------------------------------------------------------------------

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): number {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const o = (v as { o?: unknown })?.o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= MAX_NODES_PER_USER * 10) return o;
  } catch {
    // 아래에서 오류
  }
  throw new McpToolError("cursor 값이 올바르지 않습니다. 이전 응답의 nextCursor를 그대로 넘겨 주세요.");
}

export function listNodes(graph: CareerGraph, args: { label?: NodeLabel; cursor?: string; limit?: number; includeProps?: boolean }) {
  const limit = args.limit ?? LIST_NODES_DEFAULT_LIMIT;
  const offset = args.cursor ? decodeCursor(args.cursor) : 0;
  const all = args.label ? graph.nodes.filter((n) => n.label === args.label) : graph.nodes;
  const page = all.slice(offset, offset + limit);
  const items = page.map((n) => (args.includeProps ? { ...nodeSummary(n), props: nodeProps(n) } : nodeSummary(n)));
  const next = offset + page.length;
  return { items, total: all.length, nextCursor: next < all.length ? encodeCursor(next) : null };
}

// ---------------------------------------------------------------------------
// get_node
// ---------------------------------------------------------------------------

export function getNode(graph: CareerGraph, args: { id: string; neighborLimit?: number }) {
  const limit = args.neighborLimit ?? NEIGHBOR_DEFAULT_LIMIT;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const isPerson = args.id === PERSON_ID;
  const node = byId.get(args.id);
  if (!isPerson && !node) throw new McpToolError(`노드를 찾을 수 없습니다: ${args.id}`);

  const summaryOf = (id: string): NodeSummary | null => (id === PERSON_ID ? personSummary(graph) : byId.get(id) ? nodeSummary(byId.get(id)!) : null);
  const neighbors: { direction: "out" | "in"; type: RelType; relName: string; node: NodeSummary }[] = [];
  for (const e of graph.edges) {
    const out = e.from === args.id;
    if (!out && e.to !== args.id) continue;
    const other = summaryOf(out ? e.to : e.from);
    if (other) neighbors.push({ direction: out ? "out" : "in", type: e.type, relName: REL_RULES[e.type].name, node: other });
  }
  neighbors.sort((a, b) => a.type.localeCompare(b.type) || a.direction.localeCompare(b.direction) || a.node.id.localeCompare(b.node.id));

  const base = isPerson
    ? { ...personSummary(graph), props: {}, createdAt: null }
    : { ...nodeSummary(node!), props: nodeProps(node!), createdAt: iso(node!.createdAt) };
  const steps = isPerson ? null : (personPaths(graph).get(args.id) ?? null);
  return {
    node: base,
    path: steps ? { text: pathToText(steps), steps } : null,
    neighbors: neighbors.slice(0, limit),
    neighborsTotal: neighbors.length,
    neighborsTruncated: neighbors.length > limit,
  };
}

// ---------------------------------------------------------------------------
// search_graph
// ---------------------------------------------------------------------------

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function searchGraph(graph: CareerGraph, args: { query: string; limit?: number }, opts: { nowYear?: number } = {}) {
  const r = retrieve(graph, args.query, { nowYear: opts.nowYear });
  const ranked = rerank(r.candidates, r.query.intents, { fallback: r.fallback });
  const limit = args.limit ?? Math.max(MIN_K, answerK(r.query.intents));
  return {
    intents: r.query.intents,
    skills: r.query.skills,
    tags: r.query.tags.map((t) => ({ id: t, name: storyTagName(t) })),
    fallback: r.fallback,
    results: ranked.slice(0, limit).map((x, i) => ({
      rank: i + 1,
      id: x.candidate.node.id,
      label: x.candidate.node.label,
      labelName: NODE_LABEL_META[x.candidate.node.label].name,
      name: x.candidate.name,
      score: round3(x.final),
      seed: x.candidate.seed,
      pathText: pathToText(x.candidate.path),
      snippet: snippetOf(x.candidate.node),
    })),
  };
}

// ---------------------------------------------------------------------------
// get_graph_text
// ---------------------------------------------------------------------------

export function graphText(graph: CareerGraph, args: { maxChars?: number } = {}) {
  const text = graphToText(graph, { maxChars: args.maxChars ?? GRAPH_TEXT_DEFAULT_CHARS });
  return { text, chars: text.length, nodeCount: graph.nodes.length, edgeCount: graph.edges.length };
}

// ---------------------------------------------------------------------------
// get_experience_checklist
// ---------------------------------------------------------------------------

export function experienceChecklist(graph: CareerGraph) {
  const c = assessExperienceChecklist(graph);
  return {
    progress: c.progress,
    requiredDone: c.requiredDone,
    requiredTotal: c.requiredTotal,
    recommendedDone: c.recommendedDone,
    recommendedTotal: c.recommendedTotal,
    complete: c.complete,
    categories: c.categories.map((s) => ({
      id: s.id,
      name: experienceCategory(s.id).name,
      required: s.required,
      state: s.state,
      hint: s.hint,
      matchedNodeIds: s.matchedNodeIds,
      ...(s.best ? { best: { nodeId: s.best.nodeId, nodeName: s.best.nodeName, missing: s.best.missing } } : {}),
    })),
    text: checklistToPromptText(c),
  };
}

// ---------------------------------------------------------------------------
// 리소스: 그래프 스키마(정적)
// ---------------------------------------------------------------------------

export function graphSchemaDocument() {
  return {
    personId: PERSON_ID,
    note: '본인 노드 id는 "me"다. 나머지 노드 id는 서버가 만든 문자열이다. 관계 id는 `${type}:${from}:${to}`.',
    labels: NODE_LABELS.map((l) => ({
      label: l,
      name: NODE_LABEL_META[l].name,
      description: NODE_LABEL_META[l].description,
      titleKey: NODE_TITLE_KEY[l],
      props: Object.keys(NODE_PROP_SCHEMAS[l].shape),
    })),
    relations: REL_TYPES.map((t) => ({ type: t, name: REL_RULES[t].name, from: REL_RULES[t].from, to: REL_RULES[t].to })),
    storyTags: STORY_TAGS.map((t) => ({ id: t, name: storyTagName(t) })),
  };
}
