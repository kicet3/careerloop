/**
 * 그래프 변경 연산 검증·해석(순수 함수). service.applyGraphOps가 쓰기 트랜잭션 안에서 현재 노드 목록을 읽은 뒤
 * 이 함수로 연산을 검사하고, 통과한 단계만 Cypher로 실행한다. 하나라도 틀리면 아무것도 쓰지 않는다.
 */
import {
  allowedPropKeys,
  type EndpointLabel,
  type GraphOp,
  GraphOpSchema,
  isAllowedEdge,
  MAX_NODES_PER_USER,
  MAX_OPS_PER_BATCH,
  NODE_LABEL_META,
  NODE_LABELS,
  NODE_TITLE_KEY,
  type NodeLabel,
  PERSON_ID,
  REL_RULES,
  REL_TYPES,
  type RelType,
} from "@/lib/domain/graph";
import { GraphOpError } from "./errors";

export { GraphOpError };

export type PlanStep =
  | { kind: "create"; id: string; label: NodeLabel; props: Record<string, unknown> }
  | { kind: "update"; id: string; label: NodeLabel; props: Record<string, unknown> }
  | { kind: "delete"; id: string }
  | { kind: "link" | "unlink"; type: RelType; from: string; to: string };

/**
 * @param existing 사용자의 현재 노드 id → 라벨 (Person 제외)
 * @param newId 새 노드 id 생성기(테스트에서 고정 가능)
 * @param opts.maxOps 한 번에 적용할 연산 수 상한(기본 MAX_OPS_PER_BATCH). 이력서 가져오기 변경안만 더 크게 연다.
 * @returns 실행할 단계와 임시 ref → 새 id
 */
export function planGraphOps(
  existing: ReadonlyMap<string, NodeLabel>,
  ops: readonly GraphOp[],
  newId: () => string,
  opts: { maxOps?: number } = {},
): { steps: PlanStep[]; created: Record<string, string> } {
  const maxOps = opts.maxOps ?? MAX_OPS_PER_BATCH;
  if (ops.length > maxOps) throw new GraphOpError(`한 번에 ${maxOps}개까지 바꿀 수 있습니다.`);
  const nodes = new Map(existing);
  const created: Record<string, string> = {};
  const deleted = new Set<string>();
  const steps: PlanStep[] = [];

  const resolve = (ref: string, i: number): { id: string; label: EndpointLabel } => {
    if (ref === PERSON_ID) return { id: PERSON_ID, label: "Person" };
    const id = ref.startsWith("new:") ? created[ref] : ref;
    if (!id) throw new GraphOpError(`앞에서 만들지 않은 임시 참조입니다: ${ref}`, i);
    if (deleted.has(id)) throw new GraphOpError("이미 삭제한 노드입니다.", i);
    const label = nodes.get(id);
    if (!label) throw new GraphOpError("노드를 찾을 수 없습니다.", i);
    return { id, label };
  };

  ops.forEach((raw, i) => {
    // 호출자가 검증했더라도 화이트리스트(라벨·관계·속성 키)는 여기서 다시 강제한다.
    const parsed = GraphOpSchema.safeParse(raw);
    if (!parsed.success) throw new GraphOpError(`형식이 올바르지 않습니다 (${parsed.error.issues[0]?.path.join(".") ?? ""})`, i);
    const op = parsed.data;
    switch (op.op) {
      case "addNode": {
        if (!NODE_LABELS.includes(op.label)) throw new GraphOpError("허용되지 않은 라벨입니다.", i);
        if (created[op.ref]) throw new GraphOpError(`임시 참조가 중복되었습니다: ${op.ref}`, i);
        if (nodes.size + 1 > MAX_NODES_PER_USER) throw new GraphOpError(`노드는 ${MAX_NODES_PER_USER}개까지 만들 수 있습니다.`, i);
        const id = newId();
        created[op.ref] = id;
        nodes.set(id, op.label);
        steps.push({ kind: "create", id, label: op.label, props: pickProps(op.label, op.props) });
        return;
      }
      case "updateNode": {
        const target = resolve(op.id, i);
        if (target.label !== op.label) {
          throw new GraphOpError(`노드 종류가 다릅니다(${NODE_LABEL_META[op.label].name}이 아님).`, i);
        }
        const props = pickProps(op.label, op.props);
        if (props[NODE_TITLE_KEY[op.label]] === null) throw new GraphOpError("대표 이름은 지울 수 없습니다.", i);
        if (Object.keys(props).length === 0) return;
        steps.push({ kind: "update", id: target.id, label: op.label, props });
        return;
      }
      case "deleteNode": {
        const target = resolve(op.id, i);
        if (target.id === PERSON_ID) throw new GraphOpError("본인 노드는 지울 수 없습니다.", i);
        deleted.add(target.id);
        nodes.delete(target.id);
        steps.push({ kind: "delete", id: target.id });
        return;
      }
      case "addEdge":
      case "deleteEdge": {
        if (!REL_TYPES.includes(op.type)) throw new GraphOpError("허용되지 않은 관계입니다.", i);
        const from = resolve(op.from, i);
        const to = resolve(op.to, i);
        if (op.op === "addEdge" && !isAllowedEdge(op.type, from.label, to.label)) {
          throw new GraphOpError(
            `'${REL_RULES[op.type].name}' 관계는 ${labelName(from.label)} → ${labelName(to.label)} 방향으로 연결할 수 없습니다.`,
            i,
          );
        }
        steps.push({ kind: op.op === "addEdge" ? "link" : "unlink", type: op.type, from: from.id, to: to.id });
        return;
      }
    }
  });
  return { steps, created };
}

function labelName(l: EndpointLabel): string {
  return l === "Person" ? "나" : NODE_LABEL_META[l].name;
}

/** 라벨의 화이트리스트 키만 남긴다(undefined는 버리고 null은 '지우기'로 남긴다). */
function pickProps(label: NodeLabel, props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowedPropKeys(label)) {
    if (props[key] !== undefined) out[key] = props[key];
  }
  return out;
}
