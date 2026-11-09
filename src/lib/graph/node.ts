/**
 * 저장된 Neo4j 노드 속성 → GraphNode(순수). service.ts getCareerGraph가 쓰고, Python 워커(worker/app/graph/service.py)가
 * 같은 규칙을 따른다(공유 fixture: src/lib/worker/fixtures.ts → worker/tests/fixtures/graph.json).
 */
import { allowedPropKeys, type GraphNode, type NodeLabel } from "@/lib/domain/graph";
import { normalizeStoredDates } from "@/lib/domain/graph-dates";

/** 저장된 노드 → GraphNode. 옛 형식 날짜(YYYY-MM-DD, endDate '현재' 등)는 읽을 때 계약대로 보여 준다(저장값은 그대로 — 다음에 고칠 때 다시 쓴다). */
export function toGraphNode(id: string, label: NodeLabel, raw: Record<string, unknown>): GraphNode {
  const picked: Record<string, unknown> = {};
  for (const k of allowedPropKeys(label)) if (raw[k] !== undefined && raw[k] !== null) picked[k] = raw[k];
  const props = normalizeStoredDates(label, picked);
  return {
    id,
    label,
    props,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  } as GraphNode;
}
