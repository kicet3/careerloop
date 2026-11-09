import "server-only";
/**
 * 경험 그래프 저장소(Neo4j). 규칙:
 * - 모든 노드에 userId를 넣고, 모든 MATCH에 userId 조건을 건다 — 다른 사용자 노드는 id를 알아도 닿지 않는다.
 * - 값은 모두 파라미터로 넘긴다. Cypher 문자열에 끼우는 것은 화이트리스트(NODE_LABELS·REL_TYPES)를 통과한 라벨·관계 타입뿐이다.
 * - 사용자 노드는 Career 라벨 + 종류 라벨(:Career:Company 등)을 갖는다. Person은 사용자당 하나(MERGE).
 * - applyGraphOps는 한 쓰기 트랜잭션에서 현재 노드를 읽고(plan.ts로 검증) 실행한다. 하나라도 틀리면 아무것도 쓰지 않는다.
 */
import { nanoid } from "nanoid";
import type { ManagedTransaction } from "neo4j-driver";
import {
  type ApplyGraphOpsResult,
  type CareerGraph,
  edgeId,
  type GraphEdge,
  type GraphNode,
  type GraphOp,
  NODE_LABELS,
  type NodeLabel,
  PERSON_ID,
  REL_TYPES,
  type RelType,
} from "@/lib/domain/graph";
import { ensureGraphSchema, getDriver, graphDatabase } from "./client";
import { GraphOpError } from "./errors";
import { toGraphNode } from "./node";
import { GraphOwnerMismatchError, markGraphOwner } from "./owner";
import { planGraphOps, type PlanStep } from "./plan";

export { GraphOpError, GraphUnavailableError } from "./errors";
export { graphToText } from "./text";
export { graphEnabled } from "./client";

const isLabel = (v: unknown): v is NodeLabel => typeof v === "string" && (NODE_LABELS as readonly string[]).includes(v);
const isRel = (v: unknown): v is RelType => typeof v === "string" && (REL_TYPES as readonly string[]).includes(v);

function assertLabel(label: string): NodeLabel {
  if (!isLabel(label)) throw new GraphOpError("허용되지 않은 라벨입니다.");
  return label;
}
function assertRel(type: string): RelType {
  if (!isRel(type)) throw new GraphOpError("허용되지 않은 관계입니다.");
  return type;
}

function assertUserId(userId: string): void {
  if (!userId || typeof userId !== "string") throw new Error("userId가 필요합니다");
}

/**
 * 쓰기 성공 직후 에이전트 RAG 데이터 버전을 올리고(캐시 무효화·진행 중 요청의 빠른 중단), 지운 노드를 청크 연결에서 뺀다.
 * Neo4j와 Postgres는 한 트랜잭션이 아니다 — 실패해도 안전하다(최종 검증은 버전이 아니라 스냅샷 재로딩으로 한다). 오류는 코드만 남긴다.
 */
async function afterGraphWrite(userId: string, deletedNodeIds: readonly string[] = []): Promise<void> {
  try {
    const { bumpDataVersion } = await import("@/lib/rag/versions");
    await bumpDataVersion(userId);
    if (deletedNodeIds.length > 0) await (await import("@/lib/rag/chunks/store")).removeNodesFromChunks(userId, deletedNodeIds);
  } catch (err) {
    (await import("@/lib/rag/log")).ragLog("version_bump_failed", { name: err instanceof Error ? err.name : "Error" });
  }
}

async function session() {
  await ensureGraphSchema();
  return getDriver().session({ database: graphDatabase() });
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

export { toGraphNode };

export async function getCareerGraph(userId: string, opts: { personName?: string | null } = {}): Promise<CareerGraph> {
  assertUserId(userId);
  const s = await session();
  try {
    // 트랜잭션 타임아웃(드라이버 5초 — 서버 쪽 db.transaction.timeout과 함께 LIMIT만 믿지 않는 장치, docs/AGENTIC-GRAPH-RAG.md §5.3).
    return await s.executeRead(async (tx) => {
      const nodeRes = await tx.run(
        `MATCH (n:Career {userId: $userId})
         RETURN n.id AS id, [l IN labels(n) WHERE l <> 'Career'][0] AS label, properties(n) AS props
         ORDER BY n.createdAt, n.id`,
        { userId },
      );
      const nodes: GraphNode[] = [];
      for (const r of nodeRes.records) {
        const label = r.get("label");
        const props = r.get("props");
        // 심층 방어: MATCH가 userId로 거르지만, 다른 사용자 노드가 섞여 나오면(쿼리 회귀) 그래프 전체를 버린다.
        // 보안 실패로 분류되게 GraphOwnerMismatchError(rag/errors.ts sanitizeError → security_violation, 에이전트는 폴백 없이 멈춘다).
        if (props?.userId !== userId) throw new GraphOwnerMismatchError();
        if (isLabel(label)) nodes.push(toGraphNode(r.get("id"), label, props));
      }
      const edgeRes = await tx.run(
        `MATCH (a)-[r]->(b:Career {userId: $userId})
         WHERE (a:Career OR a:Person) AND a.userId = $userId
         RETURN type(r) AS type, CASE WHEN a:Person THEN $person ELSE a.id END AS from, b.id AS to`,
        { userId, person: PERSON_ID },
      );
      const ids = new Set(nodes.map((n) => n.id));
      const edges: GraphEdge[] = [];
      for (const r of edgeRes.records) {
        const type = r.get("type");
        const from: string = r.get("from");
        const to: string = r.get("to");
        if (!isRel(type) || !ids.has(to) || (from !== PERSON_ID && !ids.has(from))) continue;
        edges.push({ id: edgeId(type, from, to), type, from, to });
      }
      return markGraphOwner<CareerGraph>({ person: { id: PERSON_ID, name: opts.personName ?? null }, nodes, edges }, userId);
    }, { timeout: 5000 });
  } finally {
    await s.close();
  }
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

/** 사용자의 노드 id → 라벨, 그리고 날짜 계약 검사에 쓰는 날짜 속성(startDate·endDate·date·current — 저장값 그대로). */
async function existingNodes(
  tx: ManagedTransaction,
  userId: string,
): Promise<{ labels: Map<string, NodeLabel>; dates: Map<string, Record<string, unknown>> }> {
  const res = await tx.run(
    `MATCH (n:Career {userId: $userId})
     RETURN n.id AS id, [l IN labels(n) WHERE l <> 'Career'][0] AS label,
            {startDate: n.startDate, endDate: n.endDate, date: n.date, current: n.current} AS dates`,
    { userId },
  );
  const labels = new Map<string, NodeLabel>();
  const dates = new Map<string, Record<string, unknown>>();
  for (const r of res.records) {
    const label = r.get("label");
    if (!isLabel(label)) continue;
    labels.set(r.get("id"), label);
    const d = (r.get("dates") ?? {}) as Record<string, unknown>;
    dates.set(r.get("id"), Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined)));
  }
  return { labels, dates };
}

/** 관계 끝점 MATCH 절. Person은 userId로, 나머지는 id + userId로 찾는다. */
function endpoint(alias: "a" | "b", id: string): string {
  return id === PERSON_ID ? `MATCH (${alias}:Person {userId: $userId})` : `MATCH (${alias}:Career {id: $${alias}Id, userId: $userId})`;
}

async function runStep(tx: ManagedTransaction, userId: string, step: PlanStep, now: number): Promise<void> {
  switch (step.kind) {
    case "create": {
      const label = assertLabel(step.label);
      const props = Object.fromEntries(Object.entries(step.props).filter(([, v]) => v !== null));
      await tx.run(`CREATE (n:Career:${label}) SET n = $props, n.id = $id, n.userId = $userId, n.createdAt = $now, n.updatedAt = $now`, {
        props,
        id: step.id,
        userId,
        now,
      });
      return;
    }
    case "update": {
      // += 맵에서 null 값은 그 속성을 지운다. id·userId 같은 시스템 키는 pickProps가 이미 걸렀다.
      const res = await tx.run(`MATCH (n:Career {id: $id, userId: $userId}) SET n += $props, n.updatedAt = $now RETURN n.id`, {
        id: step.id,
        userId,
        props: step.props,
        now,
      });
      if (res.records.length === 0) throw new GraphOpError("노드를 찾을 수 없습니다.");
      return;
    }
    case "delete":
      await tx.run(`MATCH (n:Career {id: $id, userId: $userId}) DETACH DELETE n`, { id: step.id, userId });
      return;
    case "link":
    case "unlink": {
      const type = assertRel(step.type);
      const q =
        step.kind === "link"
          ? `${endpoint("a", step.from)} ${endpoint("b", step.to)} MERGE (a)-[:${type}]->(b) RETURN 1 AS ok`
          : `${endpoint("a", step.from)} ${endpoint("b", step.to)} MATCH (a)-[r:${type}]->(b) DELETE r RETURN 1 AS ok`;
      const res = await tx.run(q, { userId, aId: step.from, bId: step.to });
      if (step.kind === "link" && res.records.length === 0) throw new GraphOpError("연결할 노드를 찾을 수 없습니다.");
      return;
    }
  }
}

/**
 * 변경 연산을 한 트랜잭션으로 적용한다. 형식·존재·관계 방향이 하나라도 틀리면 GraphOpError(400)이고 아무것도 쓰지 않는다.
 * 사용자 Person 노드가 없으면 만든다. opts.maxOps는 이력서 가져오기 변경안에만 쓴다(직접 편집 API는 기본값).
 */
export async function applyGraphOps(
  userId: string,
  ops: readonly GraphOp[],
  opts: { maxOps?: number } = {},
): Promise<ApplyGraphOpsResult> {
  assertUserId(userId);
  if (ops.length === 0) return { created: {}, applied: 0 };
  const s = await session();
  let result: ApplyGraphOpsResult;
  let deleted: string[] = [];
  try {
    result = await s.executeWrite(async (tx) => {
      const now = Date.now();
      await tx.run(`MERGE (p:Person {userId: $userId}) ON CREATE SET p.createdAt = $now`, { userId, now });
      const existing = await existingNodes(tx, userId);
      const { steps, created } = planGraphOps(existing.labels, ops, () => `n_${nanoid(12)}`, { ...opts, existingProps: existing.dates });
      for (const step of steps) await runStep(tx, userId, step, now);
      deleted = steps.flatMap((st) => (st.kind === "delete" ? [st.id] : []));
      return { created, applied: steps.length };
    });
  } finally {
    await s.close();
  }
  await afterGraphWrite(userId, deleted);
  return result;
}

/** 노드 하나를 관계와 함께 지운다. 없거나 다른 사용자 노드면 false. */
export async function deleteNode(userId: string, id: string): Promise<boolean> {
  assertUserId(userId);
  const s = await session();
  let removed: boolean;
  try {
    removed = await s.executeWrite(async (tx) => {
      const res = await tx.run(`MATCH (n:Career {id: $id, userId: $userId}) DETACH DELETE n RETURN count(*) AS c`, { id, userId });
      return (res.records[0]?.get("c") ?? 0) > 0;
    });
  } finally {
    await s.close();
  }
  if (removed) await afterGraphWrite(userId, [id]);
  return removed;
}

/** 사용자의 그래프 전체(Person 포함)를 지운다. 계정 삭제·테스트 정리용. */
export async function deleteUserGraph(userId: string): Promise<void> {
  assertUserId(userId);
  const s = await session();
  try {
    await s.executeWrite(async (tx) => {
      await tx.run(`MATCH (n:Career {userId: $userId}) DETACH DELETE n`, { userId });
      await tx.run(`MATCH (p:Person {userId: $userId}) DETACH DELETE p`, { userId });
    });
  } finally {
    await s.close();
  }
  await afterGraphWrite(userId);
}
