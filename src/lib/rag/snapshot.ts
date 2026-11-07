/**
 * 본인 그래프 스냅샷(§7.2) — 검증 기준이자 조회 실행기(graph/eval-in-memory.ts)의 유일한 입력.
 * DB에는 고정 템플릿 getCareerGraph(principal)만 나간다(모든 MATCH에 userId, 다른 사용자 노드가 섞이면 전체 throw).
 * 스냅샷은 그 결과를 한 번 더 확인한다: 소유자 표시(graph/owner.ts)가 principal과 같아야 하고(표시가 없어도 거부 — fail-closed),
 * 간선 끝점은 모두 노드 집합(또는 본인 Person)에 있어야 한다. 모든 하위 객체는 얼린다. 요청마다 새로 읽고 공유하지 않는다.
 */
import {
  allowedPropKeys,
  type CareerGraph,
  type GraphEdge,
  type NodeLabel,
  NODE_LABELS,
  nodeDisplayName,
  PERSON_ID,
} from "@/lib/domain/graph";
import { graphOwnerOf } from "@/lib/graph/owner";
import { SecurityViolation } from "./errors";
import { canonicalJson, sha256 } from "./hash";

export type SnapLabel = NodeLabel | "Person";

export interface SnapNode {
  readonly id: string;
  readonly label: SnapLabel;
  /** 허용 속성만(allowedPropKeys). Person은 { name }. */
  readonly props: Readonly<Record<string, unknown>>;
  readonly title: string;
  readonly hash: string;
  readonly version: number;
}

export interface OwnedSnapshot {
  readonly principalUserId: string;
  readonly nodes: ReadonlyMap<string, SnapNode>;
  readonly edges: readonly GraphEdge[];
  readonly edgeKeys: ReadonlySet<string>;
  readonly out: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly in: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly fingerprint: string;
  /** 같은 데이터의 CareerGraph 모양(기존 순수 함수 retrieve·buildIndex 재사용용, 얼린 사본). */
  readonly graph: CareerGraph;
}

export const edgeKey = (from: string, type: string, to: string) => `${from}|${type}|${to}`;

export function nodeHash(props: Record<string, unknown>): string {
  return sha256(canonicalJson(props));
}

function pickAllowed(label: SnapLabel, props: Record<string, unknown>): Record<string, unknown> {
  if (label === "Person") return { name: typeof props.name === "string" ? props.name : null };
  const out: Record<string, unknown> = {};
  for (const k of allowedPropKeys(label)) if (props[k] !== undefined && props[k] !== null) out[k] = props[k];
  return out;
}

export function allowedPropsHash(label: SnapLabel, props: Record<string, unknown>): string {
  return nodeHash(pickAllowed(label, props));
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Record<string, unknown>)) deepFreeze(x);
  }
  return v;
}

/** 이미 읽은 그래프 → 스냅샷. 소유자 표시가 principal이 아니거나 끝점 없는 간선이 있으면 SecurityViolation('unowned_node'). */
export function buildOwnedSnapshot(graph: CareerGraph, principalUserId: string): OwnedSnapshot {
  if (!principalUserId || graphOwnerOf(graph) !== principalUserId) throw new SecurityViolation("unowned_node");
  const nodes = new Map<string, SnapNode>();
  const person: SnapNode = {
    id: PERSON_ID,
    label: "Person",
    props: { name: graph.person.name },
    title: "나",
    hash: nodeHash({ name: graph.person.name }),
    version: 0,
  };
  nodes.set(PERSON_ID, deepFreeze(person));
  const copyNodes = [];
  for (const n of graph.nodes) {
    if (!(NODE_LABELS as readonly string[]).includes(n.label) || n.id === PERSON_ID || nodes.has(n.id)) throw new SecurityViolation("unowned_node");
    const props = pickAllowed(n.label, n.props as Record<string, unknown>);
    nodes.set(n.id, deepFreeze({ id: n.id, label: n.label, props: { ...props }, title: nodeDisplayName(n), hash: nodeHash(props), version: n.updatedAt }));
    copyNodes.push({ ...n, props: { ...props } });
  }
  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to) || e.to === PERSON_ID) throw new SecurityViolation("unowned_node");
    const k = edgeKey(e.from, e.type, e.to);
    if (edgeKeys.has(k)) continue;
    edgeKeys.add(k);
    const copy = Object.freeze({ ...e });
    edges.push(copy);
    out.set(e.from, [...(out.get(e.from) ?? []), copy]);
    inn.set(e.to, [...(inn.get(e.to) ?? []), copy]);
  }
  const fingerprint = sha256(
    canonicalJson({ n: [...nodes.values()].map((n) => [n.id, n.hash]).sort(), e: [...edgeKeys].sort() }),
  );
  const snapshotGraph: CareerGraph = { person: { ...graph.person }, nodes: copyNodes as CareerGraph["nodes"], edges: edges.map((e) => ({ ...e })) };
  return deepFreeze({ principalUserId, nodes, edges, edgeKeys, out, in: inn, fingerprint, graph: snapshotGraph }) as OwnedSnapshot;
}

/** 그래프 로더(기본: getCareerGraph 고정 템플릿 — 표시를 단다). */
export type GraphLoader = (userId: string) => Promise<CareerGraph>;

export async function loadOwnedSnapshot(principalUserId: string, loader: GraphLoader): Promise<OwnedSnapshot> {
  return buildOwnedSnapshot(await loader(principalUserId), principalUserId);
}
