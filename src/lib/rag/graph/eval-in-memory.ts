/**
 * 계획 실행기(§5.2): 검증된 계획을 본인 스냅샷 위에서 메모리로 실행하는 순수 함수. I/O가 없다 — prisma·드라이버·저장소 모듈을
 * import하지 않는다(eval-in-memory.imports.test.ts). 입력 집합이 본인 스냅샷뿐이라 어떤 계획을 받아도 다른 사용자 노드를 돌려줄 수 없고,
 * 집계·존재·정렬 결과도 다른 사용자 데이터에 의존하지 않는다. 바인딩 상한·시간 상한을 넘으면 too_broad.
 */
import { normalizeGraphDate, type GraphEdge } from "@/lib/domain/graph";
import { ToolQueryError } from "../errors";
import { edgeKey, type OwnedSnapshot, type SnapNode } from "../snapshot";
import type { FilterValue, ValidatedPlan } from "./plan";
import { DATE_PROP_KEYS, MAX_BINDINGS, MAX_EVAL_MS } from "./policy";

export type PlanResult =
  | { kind: "nodes"; rows: Record<string, string>[]; truncated: boolean }
  | { kind: "paths"; rows: { nodeIds: string[]; edgeKeys: string[] }[]; truncated: boolean }
  | { kind: "aggregate"; groups: AggregateGroup[]; truncated: boolean };

export interface AggregateGroup {
  key: string | null;
  value: number | string | null;
  /** 집계에 들어간 노드 id(정렬). */
  inputIds: string[];
}

interface Binding {
  ids: string[];
  edges: string[];
}

const YEAR_ONLY = /^\d{4}$/;

const asText = (v: unknown): string | null =>
  v === undefined || v === null ? null : Array.isArray(v) ? v.join("|") : typeof v === "string" ? v : String(v);

function cmpValue(prop: string, v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return v;
  if (DATE_PROP_KEYS.includes(prop) && typeof v === "string") return normalizeGraphDate(v);
  return asText(v);
}

function matches(node: SnapNode, prop: string, op: ValidatedPlan["filters"][number]["op"], value: FilterValue | undefined): boolean {
  const raw = node.props[prop];
  if (op === "exists") return raw !== undefined && raw !== null && raw !== "";
  if (raw === undefined || raw === null) return false;
  const text = (asText(raw) ?? "").toLowerCase();
  switch (op) {
    case "eq":
      return typeof value === "string" ? text === value.toLowerCase() : raw === value || (Array.isArray(raw) && raw.includes(value));
    case "contains":
      return typeof value === "string" && text.includes(value.toLowerCase());
    case "startsWith":
      return typeof value === "string" && text.startsWith(value.toLowerCase());
    case "in":
      return Array.isArray(value) && value.some((x) => x.toLowerCase() === text || (Array.isArray(raw) && raw.includes(x)));
    case "gte":
    case "lte": {
      let a = cmpValue(prop, raw);
      let b = typeof value === "string" ? normalizeGraphDate(value) : value;
      if (a === null || b === undefined || typeof a !== typeof b) return false;
      // 날짜 속성에서 한쪽이 연도만이면 연도 정밀도로 비교한다: "2024-05" lte "2024"는 참("2024년까지"), gte "2024"도 참.
      if (DATE_PROP_KEYS.includes(prop) && typeof a === "string" && typeof b === "string" && (YEAR_ONLY.test(a) || YEAR_ONLY.test(b))) {
        a = a.slice(0, 4);
        b = b.slice(0, 4);
      }
      return op === "gte" ? (a as string | number) >= (b as string | number) : (a as string | number) <= (b as string | number);
    }
  }
}

export function evalPlan(plan: ValidatedPlan, snapshot: OwnedSnapshot, opts: { now?: () => number } = {}): PlanResult {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const check = (size: number) => {
    if (size > MAX_BINDINGS || now() - started > MAX_EVAL_MS) throw new ToolQueryError("too_broad");
  };
  const filtersFor = (vi: number) => plan.filters.filter((f) => f.varIndex === vi);
  const passes = (vi: number, nodeId: string) => {
    const node = snapshot.nodes.get(nodeId);
    if (!node || node.label !== plan.vars[vi]!.label) return false;
    const allowed = plan.vars[vi]!.nodeIds;
    if (allowed && !allowed.includes(nodeId)) return false;
    return filtersFor(vi).every((f) => matches(node, f.prop, f.op, f.value));
  };

  // 시작 집합
  const start = plan.vars[0]!;
  const startIds = start.nodeIds ?? [...snapshot.nodes.values()].filter((n) => n.label === start.label).map((n) => n.id);
  let bindings: Binding[] = startIds.filter((id) => passes(0, id)).map((id) => ({ ids: [id], edges: [] }));
  check(bindings.length);

  // hop 전개: 스냅샷 인접 목록만. 한 경로에서 같은 간선은 한 번만.
  plan.hops.forEach((hop, h) => {
    const next: Binding[] = [];
    for (const b of bindings) {
      const at = b.ids[h]!;
      const list: readonly GraphEdge[] = (hop.dir === "out" ? snapshot.out.get(at) : snapshot.in.get(at)) ?? [];
      for (const e of list) {
        if (e.type !== hop.rel) continue;
        const k = edgeKey(e.from, e.type, e.to);
        if (b.edges.includes(k)) continue;
        const other = hop.dir === "out" ? e.to : e.from;
        if (!passes(h + 1, other)) continue;
        next.push({ ids: [...b.ids, other], edges: [...b.edges, k] });
        check(next.length);
      }
    }
    bindings = next;
  });

  const propOf = (vi: number, id: string, prop: string) => snapshot.nodes.get(id)?.props[prop];
  if (plan.orderBy) {
    const { varIndex, prop, dir } = plan.orderBy;
    const sign = dir === "asc" ? 1 : -1;
    bindings = [...bindings].sort((x, y) => {
      const a = cmpValue(prop, propOf(varIndex, x.ids[varIndex]!, prop));
      const b = cmpValue(prop, propOf(varIndex, y.ids[varIndex]!, prop));
      if (a === b) return x.ids.join(",") < y.ids.join(",") ? -1 : 1;
      if (a === null) return 1;
      if (b === null) return -1;
      return (a < b ? -1 : 1) * sign;
    });
  }

  const ret = plan.ret;
  if (ret.kind === "nodes") {
    const seen = new Set<string>();
    const rows: Record<string, string>[] = [];
    for (const b of bindings) {
      const row = Object.fromEntries(ret.varIndexes.map((i) => [plan.vars[i]!.name, b.ids[i]!]));
      const key = ret.varIndexes.map((i) => b.ids[i]).join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return { kind: "nodes", rows: rows.slice(0, plan.limit), truncated: rows.length > plan.limit };
  }
  if (ret.kind === "paths") {
    const rows = bindings.map((b) => ({ nodeIds: [...b.ids], edgeKeys: [...b.edges] }));
    return { kind: "paths", rows: rows.slice(0, plan.limit), truncated: rows.length > plan.limit };
  }
  // 집계: 그룹마다 값과 입력 노드 id.
  const groups = new Map<string, { key: string | null; ids: string[] }>();
  for (const b of bindings) {
    const gk = ret.groupBy ? asText(propOf(ret.groupBy.varIndex, b.ids[ret.groupBy.varIndex]!, ret.groupBy.prop)) : null;
    const slot = groups.get(gk ?? "\u0000") ?? { key: gk, ids: [] };
    slot.ids.push(b.ids[ret.varIndex]!);
    groups.set(gk ?? "\u0000", slot);
  }
  const out: AggregateGroup[] = [];
  for (const g of groups.values()) {
    const distinct = [...new Set(g.ids)].sort();
    let value: number | string | null;
    if (ret.fn === "count") value = ret.prop ? g.ids.filter((id) => propOf(ret.varIndex, id, ret.prop!) != null).length : g.ids.length;
    else if (ret.fn === "countDistinct") value = ret.prop ? new Set(g.ids.map((id) => asText(propOf(ret.varIndex, id, ret.prop!))).filter((v) => v !== null)).size : distinct.length;
    else {
      const vals = distinct.map((id) => cmpValue(ret.prop!, propOf(ret.varIndex, id, ret.prop!))).filter((v): v is string | number => v !== null).sort();
      value = vals.length ? (ret.fn === "min" ? vals[0]! : vals.at(-1)!) : null;
    }
    out.push({ key: g.key, value, inputIds: distinct });
  }
  if (!ret.groupBy && out.length === 0) out.push({ key: null, value: ret.fn === "count" || ret.fn === "countDistinct" ? 0 : null, inputIds: [] });
  out.sort((a, b) => ((a.key ?? "") < (b.key ?? "") ? -1 : (a.key ?? "") > (b.key ?? "") ? 1 : 0));
  return { kind: "aggregate", groups: out.slice(0, 50), truncated: out.length > 50 };
}
