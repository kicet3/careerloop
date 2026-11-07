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
import {
  DATE_ISSUE_TEXT,
  type DateIssue,
  GRAPH_DATE_KEYS,
  legacyDateRewrites,
  normalizeNodeDates,
  ONGOING_LABELS,
  parseGraphDate,
} from "@/lib/domain/graph-dates";
import { kstToday } from "@/lib/time/kst";
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
 * @param opts.existingProps 노드 id → 지금 날짜 속성(startDate·endDate·date·current). 날짜 계약(시작 ≤ 종료, 진행 중 정리)을
 *   기존 값과 함께 검사하고, 옛 형식 날짜(YYYY-MM-DD 등)는 그 노드를 고칠 때 YYYY-MM으로 다시 쓴다. 없으면 이번 연산 값만 본다.
 * @param opts.today 오늘(KST, YYYY-MM-DD). 미래 날짜 검사 기준(기본 kstToday()).
 * @returns 실행할 단계와 임시 ref → 새 id
 */
export function planGraphOps(
  existing: ReadonlyMap<string, NodeLabel>,
  ops: readonly GraphOp[],
  newId: () => string,
  opts: PlanOptions = {},
): { steps: PlanStep[]; created: Record<string, string> } {
  const maxOps = opts.maxOps ?? MAX_OPS_PER_BATCH;
  const today = opts.today ?? kstToday();
  const dates = new DateState(opts.existingProps);
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
    const parsed = GraphOpSchema.safeParse(preNormalizeDates(raw));
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
        const props = datedProps(op.label, pickProps(op.label, op.props), "add", null, today, i);
        dates.set(id, props);
        steps.push({ kind: "create", id, label: op.label, props });
        return;
      }
      case "updateNode": {
        const target = resolve(op.id, i);
        if (target.label !== op.label) {
          throw new GraphOpError(`노드 종류가 다릅니다(${NODE_LABEL_META[op.label].name}이 아님).`, i);
        }
        const current = dates.get(target.id);
        const props = datedProps(op.label, pickProps(op.label, op.props), "update", current, today, i);
        if (props[NODE_TITLE_KEY[op.label]] === null) throw new GraphOpError("대표 이름은 지울 수 없습니다.", i);
        if (Object.keys(props).length === 0) return;
        // 옛 형식 날짜는 이 노드를 고칠 때 함께 YYYY-MM으로 다시 쓴다(이번 연산이 그 키를 바꾸지 않을 때만, 멱등).
        const allowed = new Set(allowedPropKeys(op.label));
        for (const [k, v] of Object.entries(current ? legacyDateRewrites(current) : {})) if (!(k in props) && allowed.has(k)) props[k] = v;
        dates.merge(target.id, props);
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

/**
 * 스키마 검사 전에 날짜 표기만 맞춘다("2024.03" → "2024-03", 종료 "현재" → current). 알아볼 수 없는 값은 그대로 둬 스키마가 막는다.
 * 미래·순서 검사는 스키마 뒤 datedProps가 한다.
 */
function preNormalizeDates(raw: GraphOp): GraphOp {
  if ((raw?.op !== "addNode" && raw?.op !== "updateNode") || !raw.props || typeof raw.props !== "object") return raw;
  const props: Record<string, unknown> = { ...(raw.props as Record<string, unknown>) };
  let changed = false;
  for (const key of GRAPH_DATE_KEYS) {
    if (typeof props[key] !== "string") continue;
    const p = parseGraphDate(props[key]);
    if (p.kind === "date" && p.value !== props[key]) {
      props[key] = p.value;
      changed = true;
    } else if (p.kind === "ongoing" && key === "endDate" && ONGOING_LABELS.has(raw.label)) {
      if (raw.op === "addNode") delete props.endDate;
      else props.endDate = null;
      props.current = true;
      changed = true;
    }
  }
  return changed ? ({ ...raw, props } as GraphOp) : raw;
}

export interface PlanOptions {
  maxOps?: number;
  existingProps?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  today?: string;
}

/** 날짜 이슈 → 사람이 읽을 사유. */
export function dateIssueText(label: NodeLabel, issue: DateIssue): string {
  const name = { startDate: "시작", endDate: "종료", date: label === "Certification" ? "취득일" : "날짜" }[issue.key];
  return `${name} '${issue.value}'은(는) ${DATE_ISSUE_TEXT[issue.reason]} 넣을 수 없습니다`;
}

/** 연산 하나의 날짜를 계약대로 맞춘다. 틀린 값이 있으면 GraphOpError(직접 편집·적용 경로 — 조용히 버리지 않는다). */
function datedProps(
  label: NodeLabel,
  props: Record<string, unknown>,
  mode: "add" | "update",
  existing: Readonly<Record<string, unknown>> | null,
  today: string,
  i: number,
): Record<string, unknown> {
  const r = normalizeNodeDates(label, props, { mode, existing, today });
  if (r.issues.length > 0) throw new GraphOpError(`${dateIssueText(label, r.issues[0]!)}.`, i);
  return pickProps(label, r.props);
}

/** 노드별 날짜 속성(기존 + 이번 변경안에서 만든·고친 것). */
class DateState {
  private readonly map = new Map<string, Record<string, unknown>>();
  constructor(existing?: ReadonlyMap<string, Readonly<Record<string, unknown>>>) {
    for (const [id, p] of existing ?? []) this.map.set(id, pickDates(p));
  }
  get(id: string): Record<string, unknown> | null {
    return this.map.get(id) ?? null;
  }
  set(id: string, props: Record<string, unknown>): void {
    this.map.set(id, pickDates(props));
  }
  merge(id: string, props: Record<string, unknown>): void {
    const next = { ...(this.map.get(id) ?? {}), ...pickDates(props) };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    this.map.set(id, next);
  }
}

const DATE_STATE_KEYS = [...GRAPH_DATE_KEYS, "current"] as const;
function pickDates(p: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of DATE_STATE_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

/**
 * 변경안(LLM 출력) 정리용: 그래프의 지금 값과 함께 날짜를 검사해 틀린 날짜 속성만 뺀다(연산은 살린다). planGraphOps와 같은 규칙이라
 * 이걸 지난 연산은 적용 때 날짜 때문에 통째로 막히지 않는다. 남은 속성이 없는 updateNode는 뺀다.
 */
export function sanitizeOpDates(
  ops: readonly GraphOp[],
  existing: ReadonlyMap<string, { label: NodeLabel; props: Readonly<Record<string, unknown>> }>,
  today: string = kstToday(),
): { ops: GraphOp[]; dropped: { op: GraphOp; issues: DateIssue[] }[] } {
  const state = new DateState(new Map([...existing].map(([id, n]) => [id, n.props])));
  const kept: GraphOp[] = [];
  const dropped: { op: GraphOp; issues: DateIssue[] }[] = [];
  for (const op of ops) {
    if (op.op !== "addNode" && op.op !== "updateNode") {
      kept.push(op);
      continue;
    }
    const key = op.op === "addNode" ? op.ref : op.id;
    const r = normalizeNodeDates(op.label, op.props as Record<string, unknown>, {
      mode: op.op === "addNode" ? "add" : "update",
      existing: op.op === "updateNode" ? state.get(op.id) : null,
      today,
    });
    const next = { ...op, props: r.props } as GraphOp;
    if (r.issues.length > 0) dropped.push({ op: next, issues: r.issues });
    if (op.op === "updateNode" && Object.keys(r.props).length === 0) continue;
    if (op.op === "addNode") state.set(key, r.props);
    else state.merge(key, r.props);
    kept.push(next);
  }
  return { ops: kept, dropped };
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
