import "server-only";
/**
 * 근거 묶음(evidence pack): JD 요건마다 경험 그래프에서 결정적으로 근거 노드를 골라 E1… ref를 단다. 이후 단계는 저장된 pack만 쓴다.
 *
 * 소유자 격리가 최우선이다. 에이전트에서 그래프를 읽는 정상 경로는 loadAgentGraph(job) 하나뿐이고(retrieve 단계와 revise의 expand),
 * 이 함수만 getCareerGraph를 부르며 곧바로 assertGraphOwner로 작업 행의 userId와 같은지 본다(isolation.test.ts가 소스로 확인한다).
 * job.userId는 DB 작업 행에서 읽은 값만 쓴다. Person 노드(이름·연락처)는 pack에 넣지 않는다. Neo4j id는 pack 안(서버)에만 있다.
 */
import { createHash } from "node:crypto";
import { type CareerGraph, type GraphNode, NODE_TITLE_KEY, nodeDisplayName } from "@/lib/domain/graph";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { hasMetric } from "@/lib/graph/completeness";
import { matchGraphToRequirements, requirementsFromJd } from "@/lib/graph/match";
import { assertGraphOwner } from "@/lib/graph/owner";
import { anchorOf, pathToText, personPaths, type GraphPathStep } from "@/lib/graph/paths";
import { assessProjectStructure } from "@/lib/graph/project-structure";
import { scoreCandidates } from "@/lib/graph/rerank";
import { buildIndex, retrieve, type QueryIntent } from "@/lib/graph/retrieve";
import { getCareerGraph } from "@/lib/graph/service";
import { extractKeywords, skillKey } from "@/lib/skills/dictionary";
import { evidenceLine } from "./evidence-text";
import type { EvidenceItem, EvidencePack, RequirementSignal } from "./schemas";

export { evidenceLine, evidenceSourceText } from "./evidence-text";
export { requirementSignals } from "./requirement-signals";

/** 에이전트가 그래프를 읽는 유일한 함수. 작업 행의 userId로만 읽고, 다른 소유자 표시면 GraphOwnerMismatchError. */
export async function loadAgentGraph(job: { userId: string }): Promise<CareerGraph> {
  return assertGraphOwner(await getCareerGraph(job.userId, { personName: null }), job.userId);
}

/**
 * 에이전트를 쓸 만한 그래프인가(노드가 하나라도 있는가). 빈 그래프면 폼은 빠른 초안만 보이고, 시작 요청은 빠른 초안으로 넘긴다
 * (JD 단계 비용·하루 한도를 쓰고 나서 retrieve에서 실패하지 않게). 그래프 저장소 오류면 false. 그래프 내용은 어디에도 넘기지 않는다.
 */
export async function hasAgentGraphMaterial(userId: string): Promise<boolean> {
  try {
    return (await loadAgentGraph({ userId })).nodes.length > 0;
  } catch {
    return false;
  }
}

export const K_PER_REQ = 5;
export const MAX_PER_ANCHOR_REQ = 2;
export const PACK_MAX_NODES = 80;
export const PACK_MAX_CHARS = 28_000;
const PROP_CAPS = [1000, 400, 200, 60, 0] as const;
const REQUIREMENT_INTENTS: readonly QueryIntent[] = ["project", "achievement"];
const SKIP_PROPS = new Set(["url", "categories", "startDate", "endDate", "date", "current"]);

// ---------------------------------------------------------------------------
// 노드 텍스트
// ---------------------------------------------------------------------------

const ym = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{4}/.test(v)) return "";
  const [y, m] = v.split("-");
  return m ? `${y}.${m}` : y!;
};

export function nodePeriod(node: GraphNode): string {
  const p = node.props as Record<string, unknown>;
  if (typeof p.date === "string") return ym(p.date);
  const start = ym(p.startDate);
  const end = p.current === true ? "현재" : ym(p.endDate);
  if (!start && !end) return "";
  return `${start}${start || end ? " ~ " : ""}${end}`.trim();
}

function propsText(node: GraphNode, cap: number): string {
  if (cap <= 0) return "";
  const titleKey = NODE_TITLE_KEY[node.label];
  return Object.entries(node.props as Record<string, unknown>)
    .filter(([k, v]) => k !== titleKey && !SKIP_PROPS.has(k) && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const full = (Array.isArray(v) ? v.join("|") : String(v)).replace(/\s+/g, " ").trim();
      return `${k}: ${full.length > cap ? `${full.slice(0, cap)}…(잘림)` : full}`;
    })
    .join(" | ");
}

// ---------------------------------------------------------------------------
// pack 만들기
// ---------------------------------------------------------------------------

export function graphFingerprint(graph: CareerGraph): string {
  const maxUpdated = graph.nodes.reduce((m, n) => Math.max(m, n.updatedAt ?? 0), 0);
  return createHash("sha256").update(`${graph.nodes.length}:${graph.edges.length}:${maxUpdated}`).digest("hex").slice(0, 32);
}

interface Ctx {
  graph: CareerGraph;
  paths: Map<string, GraphPathStep[]>;
  nodeById: Map<string, GraphNode>;
  usedSkills: Map<string, string[]>;
  companyOfRole: Map<string, string>;
}

function context(graph: CareerGraph): Ctx {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const usedSkills = new Map<string, string[]>();
  const companyOfRole = new Map<string, string>();
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    const to = nodeById.get(e.to);
    if (e.type === "USED_SKILL" && to?.label === "Skill") usedSkills.set(e.from, [...(usedSkills.get(e.from) ?? []), nodeDisplayName(to)]);
    if (e.type === "AT_COMPANY" && to?.label === "Company" && !companyOfRole.has(e.from)) companyOfRole.set(e.from, nodeDisplayName(to));
  }
  return { graph, paths: personPaths(graph), nodeById, usedSkills, companyOfRole };
}

function structureCompleteness(graph: CareerGraph, node: GraphNode): number {
  if (node.label !== "Project") return 0;
  const s = assessProjectStructure(graph, node.id);
  return s && s.total > 0 ? s.done / s.total : 0;
}

function storyCompleteness(node: GraphNode): number {
  if (node.label !== "Project" && node.label !== "Experience") return 0;
  const p = node.props as Record<string, unknown>;
  const keys = ["situation", "action", "result", "learned", "myRole"];
  return keys.filter((k) => typeof p[k] === "string" && (p[k] as string).trim()).length / keys.length;
}

function metricOf(node: GraphNode): boolean {
  const p = node.props as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  return hasMetric(node.label === "Achievement" ? `${s("value")} ${s("summary")}` : s("result"));
}

function toItem(ctx: Ctx, node: GraphNode, ref: string, cap: number): EvidenceItem {
  const path = ctx.paths.get(node.id) ?? [];
  const p = node.props as Record<string, unknown>;
  const skills = node.label === "Skill" ? [nodeDisplayName(node)] : (ctx.usedSkills.get(node.id) ?? []).slice(0, 20);
  return {
    ref,
    nodeId: node.id,
    label: node.label,
    name: nodeDisplayName(node),
    path: path.length ? pathToText(path) : nodeDisplayName(node),
    text: propsText(node, cap),
    period: nodePeriod(node),
    skills,
    hasMetric: metricOf(node),
    completeness: Math.max(storyCompleteness(node), structureCompleteness(ctx.graph, node)),
    // 뼈대 보정용 사실(verify.ts): 직무는 소속 회사·기간, 프로젝트·경험·학력은 기간, 자격은 취득일(startDate).
    facts:
      node.label === "Role"
        ? { company: ctx.companyOfRole.get(node.id) ?? null, startDate: ym(p.startDate), endDate: ym(p.endDate), current: p.current === true }
        : node.label === "Project" || node.label === "Experience" || node.label === "Education"
          ? { company: null, startDate: ym(p.startDate), endDate: ym(p.endDate), current: p.current === true }
          : node.label === "Certification"
            ? { company: null, startDate: ym(p.date), endDate: "", current: false }
            : null,
  };
}

interface Pick {
  nodeId: string;
  score: number;
}

/** 요건 하나의 근거 후보(어휘·기술이 직접 맞은 노드만 — 의도 라벨로만 들어온 후보는 근거로 치지 않는다). */
function rankForSignal(ctx: Ctx, signal: RequirementSignal, index: ReturnType<typeof buildIndex>, nowYear: number, k: number, noCutoff = false): Pick[] {
  const res = retrieve(ctx.graph, signal.query, { nowYear, paths: ctx.paths, index, intents: REQUIREMENT_INTENTS });
  const ranked = scoreCandidates(res.candidates, { noCutoff });
  // 직접 일치: 질의의 온전한 낱말(바이그램 아님 — "파이프라인"의 '프라'가 "인프라"에 맞는 식의 오탐을 막는다)이 문서 낱말과 같거나 한글 접두로 맞는다.
  const terms = [...res.query.terms.keys()].filter((t) => t.length >= 2);
  const direct = (tokens: ReadonlySet<string>) => {
    for (const tok of tokens) for (const t of terms) if (tok === t || (/^[가-힣]+$/.test(t) && tok.startsWith(t))) return true;
    return false;
  };
  const mustBonus = signal.kind === "must" ? 1 : 0;
  const scored = ranked
    // 직접 맞은 노드만 근거로 친다(어휘·기술 일치). 의도 라벨·태그로만 들어온 후보는 순위 신호일 뿐 근거가 아니다 — 상위 노드는 pack 단계에서 경로로 붙는다.
    .filter((r) => r.candidate.signals.skill > 0 || (r.candidate.signals.lexical > 0 && direct(r.candidate.tokens)))
    .map((r) => {
      const n = r.candidate.node;
      const score = r.det + 0.15 * mustBonus + 0.1 * structureCompleteness(ctx.graph, n) + 0.1 * (metricOf(n) ? 1 : 0);
      return { nodeId: n.id, score, anchor: anchorOf(n.id, ctx.paths.get(n.id)) };
    })
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  const perAnchor = new Map<string, number>();
  const out: Pick[] = [];
  for (const s of scored) {
    if (out.length >= k) break;
    const used = perAnchor.get(s.anchor) ?? 0;
    if (used >= MAX_PER_ANCHOR_REQ) continue;
    perAnchor.set(s.anchor, used + 1);
    out.push({ nodeId: s.nodeId, score: Math.round(s.score * 1000) / 1000 });
  }
  return out;
}

/** 요건의 기술 대조(match.ts): 요건 문장의 기술 키가 모두 증명됨 → proven, 일부라도 있음 → claimed, 없음 → missing, 기술 없음 → n/a. */
function skillStatusOf(signal: RequirementSignal, status: Map<string, "proven" | "claimed" | "missing">): "proven" | "claimed" | "missing" | "n/a" {
  const st = signal.skills.map((s) => status.get(s)).filter((x): x is "proven" | "claimed" | "missing" => x !== undefined);
  if (st.length === 0) return "n/a";
  if (st.every((s) => s === "proven")) return "proven";
  if (st.some((s) => s === "proven" || s === "claimed")) return "claimed";
  return "missing";
}

export interface BuildPackResult {
  pack: EvidencePack;
  warnings: string[];
  /** must 근거 0개이고 Project·Role·Experience가 하나도 없다 → LLM 비용을 쓰기 전에 멈춘다. */
  insufficient: boolean;
}

/**
 * pack 만들기(결정적, 순수 — 그래프는 loadAgentGraph로 읽은 것만 넘긴다).
 * 우선순위: 필수 요건 근거 → 경력 뼈대(회사·직무·학력·자격) → 우대 근거 → 키워드·업무 근거 → 기본 프로젝트·성과 → 문맥(경로 상위 노드).
 * 상한(노드 PACK_MAX_NODES, 글자 PACK_MAX_CHARS)을 넘으면 속성 길이를 줄이고, 그래도 넘치면 뒤 순위부터 자른다.
 */
export function buildEvidencePack(graph: CareerGraph, jd: JdAnalysis, signals: readonly RequirementSignal[], jdText: string, opts: { nowYear?: number } = {}): BuildPackResult {
  const nowYear = opts.nowYear ?? new Date().getFullYear();
  const ctx = context(graph);
  const index = buildIndex(graph);
  const match = matchGraphToRequirements(graph, requirementsFromJd(jd, jdText).requirements);
  const skillStatus = new Map<string, "proven" | "claimed" | "missing">();
  for (const m of match.items) skillStatus.set(skillKey(m.key), m.status);

  const order: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id) || !ctx.nodeById.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  const ancestors = (id: string) => (ctx.paths.get(id) ?? []).filter((s) => s.label !== "Person" && s.id !== id).map((s) => s.id);

  const perSignal = new Map<string, Pick[]>();
  for (const s of signals) perSignal.set(s.id, rankForSignal(ctx, s, index, nowYear, s.kind === "must" || s.kind === "nice" ? K_PER_REQ : 3));

  const must = signals.filter((s) => s.kind === "must");
  const nice = signals.filter((s) => s.kind === "nice");
  const others = signals.filter((s) => s.kind !== "must" && s.kind !== "nice");
  for (const s of must) for (const p of perSignal.get(s.id) ?? []) {
    push(p.nodeId);
    ancestors(p.nodeId).forEach(push);
  }
  for (const label of ["Role", "Company", "Education", "Certification"] as const) {
    graph.nodes.filter((n) => n.label === label).sort((a, b) => a.id.localeCompare(b.id)).forEach((n) => push(n.id));
  }
  for (const s of nice) for (const p of perSignal.get(s.id) ?? []) {
    push(p.nodeId);
    ancestors(p.nodeId).forEach(push);
  }
  for (const s of others) for (const p of perSignal.get(s.id) ?? []) push(p.nodeId);
  graph.nodes
    .filter((n) => n.label === "Project")
    .map((n) => ({ n, c: Math.max(storyCompleteness(n), structureCompleteness(graph, n)) }))
    .sort((a, b) => b.c - a.c || a.n.id.localeCompare(b.n.id))
    .slice(0, 6)
    .forEach(({ n }) => {
      push(n.id);
      ancestors(n.id).forEach(push);
    });
  graph.nodes
    .filter((n) => n.label === "Achievement" && metricOf(n))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 10)
    .forEach((n) => {
      push(n.id);
      ancestors(n.id).forEach(push);
    });
  // 고른 기술 노드는 직접 근거로 맞았을 때만(그래프의 모든 기술을 넣지 않는다 — 기술명 검증은 skillKeys로).

  let truncated = order.length > PACK_MAX_NODES;
  const kept = order.slice(0, PACK_MAX_NODES);
  let items: EvidenceItem[] = [];
  for (const cap of PROP_CAPS) {
    items = kept.map((id, i) => toItem(ctx, ctx.nodeById.get(id)!, `E${i + 1}`, cap));
    if (items.reduce((n, it) => n + evidenceLine(it).length + 1, 0) <= PACK_MAX_CHARS) break;
  }
  while (items.length > 1 && items.reduce((n, it) => n + evidenceLine(it).length + 1, 0) > PACK_MAX_CHARS) {
    items.pop();
    truncated = true;
  }
  const refOf = new Map(items.map((it) => [it.nodeId, it.ref]));

  const byRequirement = [...must, ...nice].map((s) => {
    const picks = (perSignal.get(s.id) ?? []).filter((p) => refOf.has(p.nodeId));
    return {
      requirementId: s.id,
      refs: picks.map((p) => refOf.get(p.nodeId)!).slice(0, 8),
      skillStatus: skillStatusOf(s, skillStatus),
      topScore: picks[0]?.score ?? 0,
    };
  });
  const found = (ids: readonly RequirementSignal[]) => ids.filter((s) => (byRequirement.find((b) => b.requirementId === s.id)?.refs.length ?? 0) > 0).length;
  const coverage = { mustFound: found(must), mustTotal: must.length, niceFound: found(nice), niceTotal: nice.length };
  const skillKeys = [...new Set(graph.nodes.filter((n) => n.label === "Skill").map((n) => skillKey(nodeDisplayName(n))))].slice(0, 400);

  const pack: EvidencePack = { version: 1, graphFingerprint: graphFingerprint(graph), items, byRequirement, coverage, truncated, skillKeys };
  const warnings: string[] = [];
  const story = graph.nodes.filter((n) => n.label === "Project" || n.label === "Role" || n.label === "Experience").length;
  if (coverage.mustFound === 0 && graph.nodes.length < 5) warnings.push("근거가 적어 대부분 질문으로 남습니다.");
  if (truncated) warnings.push("그래프가 커서 요건과 관련이 적은 노드는 근거에서 뺐습니다.");
  return { pack, warnings, insufficient: coverage.mustFound === 0 && story === 0 };
}

/**
 * 공백 재검색(revise의 expand, 결정적): 요건·키워드마다 컷오프 없이 다시 찾아 pack에 없는 노드를 E{n+1}…로 더한다(기존 ref 번호 유지).
 * 아무것도 못 찾은 요건 id는 unresolved(→ needsUserInfo). 그래프 fingerprint가 바뀌었으면 graphChanged.
 */
export function expandPack(
  graph: CareerGraph,
  pack: EvidencePack,
  targets: readonly { requirementId: string | null; query: string }[],
  opts: { nowYear?: number } = {},
): { pack: EvidencePack; added: number; unresolved: string[]; graphChanged: boolean } {
  const nowYear = opts.nowYear ?? new Date().getFullYear();
  const ctx = context(graph);
  const index = buildIndex(graph);
  const have = new Set(pack.items.map((i) => i.nodeId));
  const items = [...pack.items];
  const byRequirement = pack.byRequirement.map((b) => ({ ...b, refs: [...b.refs] }));
  const unresolved: string[] = [];
  let next = items.reduce((m, i) => Math.max(m, Number(i.ref.slice(1))), 0);
  let chars = items.reduce((n, it) => n + evidenceLine(it).length + 1, 0);
  for (const t of targets.slice(0, 20)) {
    const picks = rankForSignal(ctx, { id: t.requirementId ?? "K", kind: "nice", text: t.query, query: t.query, skills: extractKeywords(t.query).map(skillKey) }, index, nowYear, 3, true);
    const refs: string[] = [];
    for (const p of picks) {
      const existing = items.find((i) => i.nodeId === p.nodeId);
      if (existing) {
        refs.push(existing.ref);
        continue;
      }
      if (items.length >= 160 || have.has(p.nodeId)) continue;
      const item = toItem(ctx, ctx.nodeById.get(p.nodeId)!, `E${++next}`, 400);
      const len = evidenceLine(item).length + 1;
      if (chars + len > PACK_MAX_CHARS * 1.25) continue;
      chars += len;
      have.add(p.nodeId);
      items.push(item);
      refs.push(item.ref);
    }
    if (t.requirementId) {
      const row = byRequirement.find((b) => b.requirementId === t.requirementId);
      if (row) row.refs = [...new Set([...row.refs, ...refs])].slice(0, 8);
      if (refs.length === 0) unresolved.push(t.requirementId);
    }
  }
  const added = items.length - pack.items.length;
  const fingerprint = graphFingerprint(graph);
  return {
    pack: { ...pack, version: added > 0 ? pack.version + 1 : pack.version, items, byRequirement, graphFingerprint: fingerprint },
    added,
    unresolved: [...new Set(unresolved)],
    graphChanged: fingerprint !== pack.graphFingerprint,
  };
}
