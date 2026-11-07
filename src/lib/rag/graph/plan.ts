/**
 * 구조화 그래프 조회 계획(§5.1) — LLM은 Cypher가 아니라 이 JSON만 낸다. 계획은 DB에 닿지 않고 본인 스냅샷 위에서만 실행된다.
 * 스키마가 표현할 수 없는 것: UNION·서브쿼리·OPTIONAL MATCH·가변 길이 경로·경로 변수·프로시저·카테시안곱·WITH/UNWIND·쓰기·SKIP.
 * zod(.strict) 다음에 validatePlan이 의미를 검사한다(변수·간선 규칙·속성 키 집합 소속·연산/값 타입·handle 소속·공유 라벨 terminal 규칙).
 * hint는 규칙 이름만 담는다(입력값을 되풀이하지 않는다).
 */
import { z } from "zod";
import { allowedPropKeys, type EndpointLabel, isAllowedEdge, NODE_LABELS, type NodeLabel, REL_TYPES, type RelType } from "@/lib/domain/graph";
import type { OwnedSnapshot, SnapLabel } from "../snapshot";
import { HandleSchema } from "../tools/ids";
import { DATE_PROP_KEYS, MAX_HOPS, MAX_PLAN_LIMIT, SHARED_LABELS, SYSTEM_PROP_KEYS } from "./policy";

const VarName = z.string().regex(/^[a-z][a-z0-9]{0,7}$/);
const PropKey = z.string().min(1).max(40);
/** 공유 라벨 자리(`Shared:<라벨>`). 허용 목록이 비어 있어 지금은 의미 검증에서 모두 거부된다. */
const SharedLabel = z.string().regex(/^Shared:[A-Z][A-Za-z]{1,30}$/);
const LabelSchema = z.union([z.enum(NODE_LABELS), z.literal("Person"), SharedLabel]);

export const NodePatternSchema = z
  .object({
    var: VarName,
    label: LabelSchema,
    handles: z.array(HandleSchema).min(1).max(20).optional(),
  })
  .strict();

export const HopSchema = z.object({ rel: z.enum(REL_TYPES), dir: z.enum(["out", "in"]), to: NodePatternSchema }).strict();

const FilterValue = z.union([z.string().max(100), z.number().finite(), z.boolean(), z.array(z.string().max(100)).max(20)]);
export const FilterSchema = z
  .object({
    var: VarName,
    prop: PropKey,
    op: z.enum(["eq", "contains", "startsWith", "gte", "lte", "in", "exists"]),
    value: FilterValue.optional(),
  })
  .strict();

export const AGG_FNS = Object.freeze(["count", "countDistinct", "min", "max"] as const);
export const ReturnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nodes"), vars: z.array(VarName).min(1).max(4) }).strict(),
  z.object({ kind: z.literal("paths") }).strict(),
  z
    .object({
      kind: z.literal("aggregate"),
      fn: z.enum(AGG_FNS),
      var: VarName,
      prop: PropKey.optional(),
      groupBy: z.object({ var: VarName, prop: PropKey }).strict().optional(),
    })
    .strict(),
]);

export const QueryPlanSchema = z
  .object({
    start: NodePatternSchema,
    hops: z.array(HopSchema).max(MAX_HOPS).default([]),
    filters: z.array(FilterSchema).max(8).default([]),
    return: ReturnSchema,
    orderBy: z.object({ var: VarName, prop: PropKey, dir: z.enum(["asc", "desc"]) }).strict().optional(),
    limit: z.number().int().min(1).max(MAX_PLAN_LIMIT).default(20),
  })
  .strict();
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

export type FilterOp = z.infer<typeof FilterSchema>["op"];
export type FilterValue = z.infer<typeof FilterValue>;

/** 검증을 통과한 계획: handle은 스냅샷 노드 id로 풀렸고, 속성 키는 허용 목록 상수의 값이다. */
export interface ValidatedPlan {
  readonly validated: true;
  readonly vars: readonly { name: string; label: SnapLabel; nodeIds: readonly string[] | null }[];
  readonly hops: readonly { rel: RelType; dir: "out" | "in" }[];
  readonly filters: readonly { varIndex: number; prop: string; op: FilterOp; value: FilterValue | undefined }[];
  readonly ret:
    | { kind: "nodes"; varIndexes: readonly number[] }
    | { kind: "paths" }
    | { kind: "aggregate"; fn: (typeof AGG_FNS)[number]; varIndex: number; prop: string | null; groupBy: { varIndex: number; prop: string } | null };
  readonly orderBy: { varIndex: number; prop: string; dir: "asc" | "desc" } | null;
  readonly limit: number;
}

export type PlanCheck = { ok: true; plan: ValidatedPlan } | { ok: false; code: "plan_rejected" | "not_found"; hint: string };

export interface PlanContext {
  snapshot: OwnedSnapshot;
  /** 이번 요청 레지스트리의 handle → 노드 id(+라벨). 없으면 null. */
  resolveNodeHandle(handle: string): { nodeId: string; label: SnapLabel } | null;
  /** 테스트 주입용 공유 라벨 허용 목록(기본 SHARED_LABELS — 빈 목록). */
  sharedLabels?: readonly string[];
}

const reject = (hint: string): PlanCheck => ({ ok: false, code: "plan_rejected", hint });

const isShared = (label: string) => label.startsWith("Shared:");
/** 공유 라벨의 기본 라벨(Shared:Skill → Skill). 간선 규칙 검사용. */
const baseLabel = (label: string): EndpointLabel | null => {
  const b = isShared(label) ? label.slice("Shared:".length) : label;
  return b === "Person" || (NODE_LABELS as readonly string[]).includes(b) ? (b as EndpointLabel) : null;
};

/** 라벨의 허용 속성 키 상수(입력 문자열이 아니라 이 배열의 원소를 돌려준다). */
function canonicalProp(label: string, prop: string): string | null {
  if (SYSTEM_PROP_KEYS.includes(prop)) return null;
  const base = baseLabel(label);
  if (!base) return null;
  const keys = base === "Person" ? ["name"] : allowedPropKeys(base as NodeLabel);
  return keys.find((k) => k === prop) ?? null;
}

export function validatePlan(plan: QueryPlan, ctx: PlanContext): PlanCheck {
  const shared = ctx.sharedLabels ?? SHARED_LABELS;
  const patterns = [plan.start, ...plan.hops.map((h) => h.to)];
  const names = new Set<string>();
  for (const p of patterns) {
    if (names.has(p.var)) return reject("duplicate_var");
    names.add(p.var);
    if (isShared(p.label) && !shared.includes(p.label)) return reject("unknown_label");
  }
  if (patterns.filter((p) => p.label === "Person").length > 1) return reject("person_repeated");
  // 공유 노드는 경로의 끝에만(시작·중간 금지 — 공유 노드에서 다른 노드로 이동 불가).
  if (isShared(plan.start.label)) return reject("shared_not_terminal");
  for (let i = 0; i < patterns.length - 1; i++) if (isShared(patterns[i]!.label)) return reject("shared_not_terminal");
  // 간선 규칙(방향 반영).
  for (let i = 0; i < plan.hops.length; i++) {
    const from = baseLabel(patterns[i]!.label);
    const to = baseLabel(patterns[i + 1]!.label);
    const hop = plan.hops[i]!;
    if (!from || !to) return reject("unknown_label");
    const ok = hop.dir === "out" ? isAllowedEdge(hop.rel, from, to) : isAllowedEdge(hop.rel, to, from);
    if (!ok) return reject("edge_not_allowed");
  }
  const indexOf = (v: string) => patterns.findIndex((p) => p.var === v);
  const labelOf = (i: number) => patterns[i]!.label;

  const filters: ValidatedPlan["filters"][number][] = [];
  for (const f of plan.filters) {
    const vi = indexOf(f.var);
    if (vi < 0) return reject("unknown_var");
    const prop = canonicalProp(labelOf(vi), f.prop);
    if (!prop) return reject("unknown_prop");
    const v = f.value;
    const isDate = DATE_PROP_KEYS.includes(prop);
    switch (f.op) {
      case "exists":
        if (v !== undefined) return reject("bad_value");
        break;
      case "contains":
      case "startsWith":
        if (typeof v !== "string" || v.length === 0) return reject("bad_value");
        break;
      case "gte":
      case "lte":
        if (!(typeof v === "number" || (isDate && typeof v === "string" && /^\d{4}(-\d{2})?$/.test(v)))) return reject("bad_value");
        break;
      case "in":
        if (!Array.isArray(v) || v.length === 0) return reject("bad_value");
        break;
      case "eq":
        if (v === undefined || Array.isArray(v)) return reject("bad_value");
        break;
    }
    filters.push({ varIndex: vi, prop, op: f.op, value: v });
  }

  let ret: ValidatedPlan["ret"];
  if (plan.return.kind === "nodes") {
    const idx = plan.return.vars.map(indexOf);
    if (idx.some((i) => i < 0)) return reject("unknown_var");
    ret = { kind: "nodes", varIndexes: [...new Set(idx)] };
  } else if (plan.return.kind === "paths") {
    ret = { kind: "paths" };
  } else {
    const r = plan.return;
    const vi = indexOf(r.var);
    if (vi < 0) return reject("unknown_var");
    if (isShared(labelOf(vi)) && (r.fn === "count" || r.fn === "countDistinct")) return reject("shared_aggregate");
    let prop: string | null = null;
    if (r.prop !== undefined) {
      prop = canonicalProp(labelOf(vi), r.prop);
      if (!prop) return reject("unknown_prop");
    }
    if ((r.fn === "min" || r.fn === "max") && (!prop || !DATE_PROP_KEYS.includes(prop))) return reject("aggregate_prop");
    let groupBy: { varIndex: number; prop: string } | null = null;
    if (r.groupBy) {
      const gi = indexOf(r.groupBy.var);
      if (gi < 0) return reject("unknown_var");
      if (isShared(labelOf(gi))) return reject("shared_aggregate");
      const gp = canonicalProp(labelOf(gi), r.groupBy.prop);
      if (!gp) return reject("unknown_prop");
      groupBy = { varIndex: gi, prop: gp };
    }
    ret = { kind: "aggregate", fn: r.fn, varIndex: vi, prop, groupBy };
  }

  let orderBy: ValidatedPlan["orderBy"] = null;
  if (plan.orderBy) {
    const oi = indexOf(plan.orderBy.var);
    if (oi < 0) return reject("unknown_var");
    const op = canonicalProp(labelOf(oi), plan.orderBy.prop);
    if (!op) return reject("unknown_prop");
    orderBy = { varIndex: oi, prop: op, dir: plan.orderBy.dir };
  }

  // handle → 스냅샷 노드 id(레지스트리에 있고, 라벨이 같고, 지금 스냅샷에 있어야 한다). 하나라도 아니면 not_found.
  const vars: { name: string; label: SnapLabel; nodeIds: readonly string[] | null }[] = [];
  for (const p of patterns) {
    let nodeIds: string[] | null = null;
    if (p.handles) {
      nodeIds = [];
      for (const h of p.handles) {
        const r = ctx.resolveNodeHandle(h);
        if (!r || r.label !== p.label || !ctx.snapshot.nodes.has(r.nodeId)) return { ok: false, code: "not_found", hint: "unknown_handle" };
        nodeIds.push(r.nodeId);
      }
    }
    vars.push({ name: p.var, label: p.label as SnapLabel, nodeIds });
  }

  return {
    ok: true,
    plan: Object.freeze({
      validated: true as const,
      vars,
      hops: plan.hops.map((h) => ({ rel: h.rel, dir: h.dir })),
      filters,
      ret,
      orderBy,
      limit: plan.limit,
    }),
  };
}
