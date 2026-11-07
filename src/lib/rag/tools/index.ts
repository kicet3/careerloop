/**
 * 에이전트 도구(§4): get_schema, resolve_entity, query_graph, search_chunks, get_source.
 * - 인자 스키마는 모두 .strict() — userId·tenant·admin·cypher 같은 키는 invalid_args. 범위 정보는 scope.ctx뿐이다.
 * - 입력 id는 이번 요청 레지스트리의 handle·evidence_id만 받는다(노드 id·청크 id는 형식에서 거부). 없는 id·타인 id·삭제된 id·다른 요청의
 *   handle은 모두 같은 not_found이고, 이 확인은 메모리 Map 조회뿐이라 DB를 읽지 않는다.
 * - 원시 결과는 scope.validateBatch를 통과해야만 렌더링된다. SecurityViolation은 ToolOutcome이 아니다 — 위로 던져 요청을 멈춘다.
 * - 어떤 도구도 다른 사용자 기준 개수·이름·샘플을 돌려주지 않는다. truncated는 "본인 결과가 상한에서 잘렸다"는 불리언 하나뿐이다.
 */
import { z } from "zod";
import { CHAT_TAGS } from "@/lib/domain/chat";
import { NODE_LABEL_META, NODE_LABELS, NODE_PROP_SCHEMAS, NODE_TITLE_KEY, REL_RULES, REL_TYPES } from "@/lib/domain/graph";
import { analyzeQuery, bm25f, buildIndex, rawTokens } from "@/lib/graph/retrieve";
import { canonicalSkill, skillKey } from "@/lib/skills/dictionary";
import type { AuthContext } from "../auth-context";
import { CHUNK_SOURCE_TYPES, type ChunkSourceType, queryLexemes } from "../chunks/build";
import type { ChunkQuery, ChunkRow } from "../chunks/store";
import { type QueryErrorCode, SecurityViolation, ToolQueryError } from "../errors";
import { evalPlan, type PlanResult } from "../graph/eval-in-memory";
import { QueryPlanSchema, validatePlan, type ValidatedPlan } from "../graph/plan";
import { MAX_HOPS, MAX_PLAN_LIMIT, SHARED_LABELS } from "../graph/policy";
import type { Evidence } from "../registry";
import type { RequestScope } from "../scope";
import type { OwnedSnapshot } from "../snapshot";
import type { RawItem } from "../validator";
import { EvidenceIdSchema, HandleSchema } from "./ids";

export const TOOL_NAMES = Object.freeze(["get_schema", "resolve_entity", "query_graph", "search_chunks", "get_source"] as const);
export type ToolName = (typeof TOOL_NAMES)[number];

export const GetSchemaArgs = z.object({}).strict();
export const ResolveEntityArgs = z
  .object({
    text: z.string().min(1).max(100),
    labels: z.array(z.enum(NODE_LABELS)).max(8).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export const QueryGraphArgs = z.object({ plan: QueryPlanSchema }).strict();
export const SearchChunksArgs = z
  .object({
    query: z.string().min(1).max(300),
    scope: z
      .object({
        handles: z.array(HandleSchema).min(1).max(20).optional(),
        sourceTypes: z.array(z.enum(CHUNK_SOURCE_TYPES)).min(1).max(3).optional(),
      })
      .strict()
      .optional(),
    // "vector"·"hybrid"는 임베딩 공급자를 정한 뒤 추가한다(지금은 키워드 FTS만 동작한다).
    mode: z.enum(["keyword"]).default("keyword"),
    limit: z.number().int().min(1).max(8).default(5),
  })
  .strict();
export const GetSourceArgs = z
  .object({
    evidenceId: EvidenceIdSchema,
    window: z.number().int().min(0).max(1200).default(400),
  })
  .strict();

export const TOOL_ARGS = {
  get_schema: GetSchemaArgs,
  resolve_entity: ResolveEntityArgs,
  query_graph: QueryGraphArgs,
  search_chunks: SearchChunksArgs,
  get_source: GetSourceArgs,
} as const;

/** 도구 결과(LLM에 보이는 형태). 보안 실패는 여기 없다 — 루프를 멈춘다. */
export type ToolOutcome =
  | { status: "ok"; evidence: Evidence[]; truncated: boolean; text: string }
  | { status: "empty" }
  | { status: "error"; code: QueryErrorCode; hint?: string };

/** 바꿔 낄 수 있는 검색기·실행기(테스트가 "실수로 B를 돌려주는" 가짜를 주입한다). 결과는 늘 validateBatch를 거친다. */
export interface ToolDeps {
  searchChunks(ctx: AuthContext, q: ChunkQuery): Promise<ChunkRow[]>;
  evalPlan(plan: ValidatedPlan, snapshot: OwnedSnapshot): PlanResult;
  /** 테스트 주입 공유 라벨(기본 빈 목록). */
  sharedLabels?: readonly string[];
}

export const TOOL_LIMITS: Record<ToolName, number> = { get_schema: 1, resolve_entity: 6, query_graph: 6, search_chunks: 4, get_source: 4 };
export const RENDER_PER_CALL = 4000;

/** 정적 스키마 문서(코드 상수 — 인스턴스 데이터·개수·샘플 없음). */
export function schemaDocument(): string {
  const labels = NODE_LABELS.map(
    (l) => `- ${l}(${NODE_LABEL_META[l].name}): ${NODE_LABEL_META[l].description}. 대표 속성 ${NODE_TITLE_KEY[l]}, 속성 ${Object.keys(NODE_PROP_SCHEMAS[l].shape).join(", ")}`,
  );
  const rels = REL_TYPES.map((t) => `- ${t}(${REL_RULES[t].name}): ${REL_RULES[t].from.join("|")} → ${REL_RULES[t].to.join("|")}`);
  return [
    "라벨(Person은 본인 1개, 속성 name만):",
    ...labels,
    "관계(방향 고정):",
    ...rels,
    `제한: hops ≤ ${MAX_HOPS}, limit ≤ ${MAX_PLAN_LIMIT}, 집계 count|countDistinct|min|max(min·max는 startDate·endDate·date만), id·userId·createdAt·updatedAt는 쓸 수 없음.`,
    `문서 조각 출처 유형: ${CHUNK_SOURCE_TYPES.join(", ")}(키워드 검색만).`,
  ].join("\n");
}

function okFrom(scope: RequestScope, rendered: { evidence: Evidence[]; text: string }, truncated: boolean): ToolOutcome {
  if (rendered.evidence.length === 0) return { status: "empty" };
  const text = rendered.text.length > RENDER_PER_CALL ? `${rendered.text.slice(0, RENDER_PER_CALL)}\n…(잘림)` : rendered.text;
  void scope;
  return { status: "ok", evidence: rendered.evidence, truncated: truncated || rendered.text.length > RENDER_PER_CALL, text };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/|?!~"'`]+/g, "");

async function resolveEntity(scope: RequestScope, args: z.infer<typeof ResolveEntityArgs>): Promise<ToolOutcome> {
  const snap = scope.snapshot;
  const allowed = args.labels ? new Set<string>(args.labels) : null;
  const nodes = [...snap.nodes.values()].filter((n) => n.label !== "Person" && (!allowed || allowed.has(n.label)));
  if (nodes.length === 0) return { status: "empty" };
  const q = norm(args.text);
  const qSkill = canonicalSkill(args.text);
  const qTokens = new Set(rawTokens(args.text).map(norm).filter(Boolean));
  const scored = new Map<string, { score: number; matchedBy: "exact" | "alias" | "lexical" }>();
  for (const n of nodes) {
    const t = norm(n.title);
    // 짧은 제목(기술 'C'·'R'·'Go')이 아무 질의에나 부분 일치하지 않게: 포함 일치는 제목이 2자(라틴만이면 3자) 이상이거나 질의의 토큰과 같을 때만.
    const contains = (t.length >= (/^[a-z0-9+#]+$/.test(t) ? 3 : 2) && q.includes(t)) || qTokens.has(t) || (q.length >= 2 && t.length >= 2 && t.includes(q));
    if (t && (t === q || contains)) scored.set(n.id, { score: t === q ? 10 : 6, matchedBy: "exact" });
    else if (qSkill && n.label === "Skill" && skillKey(n.title) === skillKey(qSkill)) scored.set(n.id, { score: 8, matchedBy: "alias" });
  }
  const index = buildIndex(snap.graph);
  const lex = bm25f(
    index.indexed.filter((d) => !allowed || allowed.has(d.node.label)),
    analyzeQuery(args.text),
  );
  for (const [id, s] of lex) if (s > 0 && !scored.has(id)) scored.set(id, { score: s, matchedBy: "lexical" });
  const ranked = [...scored.entries()].sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1));
  const top = ranked.slice(0, args.limit);
  if (top.length === 0) return { status: "empty" };
  const raw: RawItem[] = top.map(([id, m]) => ({ kind: "node", id, label: snap.nodes.get(id)!.label, meta: m }));
  const v = await scope.validateBatch(raw);
  return okFrom(scope, scope.renderForLlm(v), ranked.length > args.limit);
}

async function queryGraph(scope: RequestScope, args: z.infer<typeof QueryGraphArgs>, deps: ToolDeps): Promise<ToolOutcome> {
  const check = validatePlan(args.plan, {
    snapshot: scope.snapshot,
    resolveNodeHandle: (h) => scope.registry.resolveNodeHandle(h),
    sharedLabels: deps.sharedLabels ?? SHARED_LABELS,
  });
  if (!check.ok) return { status: "error", code: check.code, hint: check.hint };
  const plan = check.plan;
  let result: PlanResult;
  try {
    result = deps.evalPlan(plan, scope.snapshot);
  } catch (err) {
    if (err instanceof ToolQueryError) return { status: "error", code: err.code };
    if (err instanceof SecurityViolation) throw err;
    return { status: "error", code: "unavailable" };
  }
  let raw: RawItem[];
  if (result.kind === "nodes") {
    const ids = [...new Set(result.rows.flatMap((r) => Object.values(r)))];
    raw = ids.map((id) => ({ kind: "node", id, label: scope.snapshot.nodes.get(id)?.label ?? "?" }));
  } else if (result.kind === "paths") {
    raw = result.rows.map((r) => ({
      kind: "path",
      nodes: r.nodeIds.map((id) => ({ id, label: scope.snapshot.nodes.get(id)?.label ?? "?" })),
      edges: r.edgeKeys.map((k) => {
        const [from, type, to] = k.split("|");
        return { from: from!, type: type!, to: to! };
      }),
    }));
  } else {
    raw = [{ kind: "aggregate", plan, groups: result.groups }];
  }
  if (raw.length === 0) return { status: "empty" };
  const v = await scope.validateBatch(raw);
  return okFrom(scope, scope.renderForLlm(v), result.truncated);
}

async function searchChunks(scope: RequestScope, args: z.infer<typeof SearchChunksArgs>, deps: ToolDeps): Promise<ToolOutcome> {
  const lexemes = queryLexemes(args.query);
  if (lexemes.length === 0) return { status: "empty" };
  let nodeIds: string[] | undefined;
  if (args.scope?.handles) {
    nodeIds = [];
    for (const h of args.scope.handles) {
      const r = scope.registry.resolveNodeHandle(h);
      if (!r) return { status: "error", code: "not_found" };
      if (scope.snapshot.nodes.has(r.nodeId)) nodeIds.push(r.nodeId);
    }
    // 하나도 남지 않으면 SQL을 실행하지 않는다(빈 배열이 "범위 없음"으로 넓어지지 않게).
    if (nodeIds.length === 0) return { status: "empty" };
  }
  let rows: ChunkRow[];
  try {
    rows = await deps.searchChunks(scope.ctx, {
      lexemes,
      ...(nodeIds ? { nodeIds } : {}),
      ...(args.scope?.sourceTypes ? { sourceTypes: args.scope.sourceTypes as ChunkSourceType[] } : {}),
      limit: args.limit,
    });
  } catch (err) {
    if (err instanceof SecurityViolation) throw err;
    const msg = err instanceof Error ? err.message : "";
    return { status: "error", code: /timeout|canceling statement/i.test(msg) ? "timeout" : "unavailable" };
  }
  if (rows.length === 0) return { status: "empty" };
  // 검색기가 무엇을 돌려줘도 전부 검증한다(하나라도 타인 것이면 SecurityViolation — 묶음 전체를 버린다).
  const v = await scope.validateBatch(rows.map((row) => ({ kind: "chunk", row })));
  const rendered = scope.renderForLlm(v);
  const kept = { evidence: rendered.evidence.slice(0, args.limit), text: "" };
  kept.text = kept.evidence.map((e) => scope.renderEvidence(e)).join("\n");
  return okFrom(scope, kept, rendered.evidence.length > args.limit);
}

async function getSource(scope: RequestScope, args: z.infer<typeof GetSourceArgs>): Promise<ToolOutcome> {
  const ev = scope.registry.get(args.evidenceId);
  if (!ev) return { status: "error", code: "not_found" };
  let raw: RawItem;
  if (ev.kind === "chunk") raw = { kind: "source-span", parentEvidenceId: ev.evidenceId, window: args.window };
  else if (ev.kind === "node") raw = { kind: "node-detail", evidenceId: ev.evidenceId };
  else return { status: "error", code: "invalid_args" };
  const v = await scope.validateBatch([raw]);
  if (v.items.length === 0) return { status: "error", code: "not_found" };
  return okFrom(scope, scope.renderForLlm(v), false);
}

/** 도구 호출 하나: 인자 재검사(strict) → 실행 → 검증 → 렌더. SecurityViolation은 그대로 던진다. */
export async function executeTool(scope: RequestScope, tool: string, rawArgs: unknown, deps: ToolDeps): Promise<ToolOutcome> {
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) return { status: "error", code: "invalid_args", hint: "unknown_tool" };
  const name = tool as ToolName;
  const parsed = TOOL_ARGS[name].safeParse(rawArgs ?? {});
  if (!parsed.success) return { status: "error", code: "invalid_args", hint: parsed.error.issues[0]?.code ?? "invalid" };
  const count = scope.countCall(name);
  if (count.tool > TOOL_LIMITS[name]) return { status: "error", code: "budget", hint: "tool_limit" };
  switch (name) {
    case "get_schema":
      return { status: "ok", evidence: [], truncated: false, text: `<${CHAT_TAGS.evidence}>\n[schema] · 스키마(정적 문서, 근거 아님)\n${schemaDocument()}\n</${CHAT_TAGS.evidence}>` };
    case "resolve_entity":
      return resolveEntity(scope, parsed.data as z.infer<typeof ResolveEntityArgs>);
    case "query_graph":
      return queryGraph(scope, parsed.data as z.infer<typeof QueryGraphArgs>, deps);
    case "search_chunks":
      return searchChunks(scope, parsed.data as z.infer<typeof SearchChunksArgs>, deps);
    case "get_source":
      return getSource(scope, parsed.data as z.infer<typeof GetSourceArgs>);
  }
}

export const defaultEvalPlan: ToolDeps["evalPlan"] = (plan, snapshot) => evalPlan(plan, snapshot);
