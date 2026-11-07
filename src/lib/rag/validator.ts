/**
 * Evidence Validator(§7). 도구의 원시 결과(미검증)를 권위 레코드(본인 스냅샷·출처 재조회)와 대조해 ValidatedResult로 만든다.
 * - owner 메타데이터(청크 행 user_id, raw props의 userId)는 믿지 않는다. 값은 통과한 id로 스냅샷·권위 원문에서 다시 꺼낸다 —
 *   검색기가 B의 텍스트를 A의 id에 붙여 돌려줘도 LLM에 보이는 텍스트는 A의 권위 레코드다.
 * - 위반(타인·소유 불명·조작)은 SecurityViolation — 묶음 전체를 버리고 요청을 중단한다(fail-closed). 품질 문제(출처 없음·해시 불일치·
 *   버전 다름)는 그 항목만 drop한다.
 * - ValidatedResult는 이 모듈만 만든다(타입 브랜드 + 요청 스코프 WeakSet 등록). 밖에서 캐스트해도 WeakSet에 없어 쓰이지 않는다.
 */
import { REL_TYPES, type RelType } from "@/lib/domain/graph";
import type { AuthContext } from "./auth-context";
import type { AuthoritativeSource } from "./chunks/authoritative";
import { type ChunkSourceType, isChunkSourceType } from "./chunks/build";
import type { ChunkRow } from "./chunks/store";
import { SecurityViolation } from "./errors";
import { type AggregateGroup, evalPlan } from "./graph/eval-in-memory";
import type { ValidatedPlan } from "./graph/plan";
import { sha256 } from "./hash";
import type { Evidence, EvidenceRegistry, ValidatedItem } from "./registry";
import { aggregateBody, chunkBody, CHUNK_RENDER_MAX, edgeBody, labelName, nodeBody, pathBody, safeText } from "./render";
import { allowedPropsHash, edgeKey, type OwnedSnapshot } from "./snapshot";
import { canonicalJson } from "./hash";

export type RawItem =
  | { kind: "node"; id: string; label: string; props?: Record<string, unknown>; meta?: Record<string, unknown> }
  | { kind: "edge"; from: string; type: string; to: string }
  | { kind: "path"; nodes: { id: string; label: string }[]; edges: { from: string; type: string; to: string }[] }
  | { kind: "aggregate"; plan: ValidatedPlan; groups: AggregateGroup[] }
  | { kind: "chunk"; row: ChunkRow }
  | { kind: "source-span"; parentEvidenceId: string; window: number }
  | { kind: "node-detail"; evidenceId: string }
  | { kind: "derived"; op: "profile-summary" | "timeline"; inputEvidenceIds: string[] };

export type DropReason = "stale_version" | "source_missing" | "hash_mismatch_same_owner" | "over_cap" | "not_found";

declare const validatedBrand: unique symbol;
export type ValidatedResult = {
  readonly [validatedBrand]: true;
  readonly items: readonly ValidatedItem[];
  readonly dropped: readonly { reason: DropReason }[];
};

/** 검증기가 쓰는 요청 상태(scope.ts RequestScope가 구현). */
export interface ValidationScope {
  readonly ctx: AuthContext;
  readonly snapshot: OwnedSnapshot;
  readonly registry: EvidenceRegistry;
  readonly validated: WeakSet<object>;
  readSource(sourceType: ChunkSourceType, sourceId: string): Promise<AuthoritativeSource | null>;
  sourceExistsElsewhere(sourceType: ChunkSourceType, sourceId: string): Promise<boolean>;
}

const isRel = (v: string): v is RelType => (REL_TYPES as readonly string[]).includes(v);
const META_KEYS: readonly string[] = Object.freeze(["matchedBy", "score"]);

function safeMeta(meta: Record<string, unknown> | undefined): Record<string, string | number> | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!META_KEYS.includes(k)) continue;
    if (k === "matchedBy" && (v === "exact" || v === "alias" || v === "lexical")) out[k] = v;
    if (k === "score" && typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
  }
  return Object.keys(out).length ? out : undefined;
}

function nodeItem(s: OwnedSnapshot, id: string, opts: { full?: boolean; meta?: Record<string, string | number> } = {}): ValidatedItem {
  const n = s.nodes.get(id)!;
  return {
    kind: "node",
    sourceKey: n.id,
    version: n.hash,
    content: nodeBody(n, { full: opts.full }),
    inputIds: [n.id],
    nodeLabel: n.label,
    display: { label: labelName(n.label), name: n.title, snippet: nodeBody(n).split("\n")[1]?.replace(/^속성: /, "").slice(0, 200) ?? "" },
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
}

function checkNode(s: OwnedSnapshot, id: unknown, label: unknown): void {
  if (typeof id !== "string" || !s.nodes.has(id)) throw new SecurityViolation("foreign_node");
  if (typeof label !== "string" || s.nodes.get(id)!.label !== label) throw new SecurityViolation("unknown_label");
}

function checkEdge(s: OwnedSnapshot, e: { from: unknown; type: unknown; to: unknown }): string {
  if (typeof e.from !== "string" || typeof e.to !== "string" || typeof e.type !== "string") throw new SecurityViolation("foreign_edge");
  if (!s.nodes.has(e.from) || !s.nodes.has(e.to)) throw new SecurityViolation("foreign_edge");
  const k = edgeKey(e.from, e.type, e.to);
  if (!s.edgeKeys.has(k)) throw new SecurityViolation("foreign_edge");
  return k;
}

const sameGroups = (a: readonly AggregateGroup[], b: readonly AggregateGroup[]) =>
  canonicalJson(a.map((g) => ({ ...g, inputIds: [...g.inputIds].sort() }))) === canonicalJson(b.map((g) => ({ ...g, inputIds: [...g.inputIds].sort() })));

/** 청크의 권위 원문 구간을 확인한다. 통과하면 { text, source }, 아니면 drop 사유. 타인 소유면 SecurityViolation. */
async function verifyChunkSource(
  scope: ValidationScope,
  row: { source_type: string; source_id: string; span_start: number; span_end: number; content_hash: string },
): Promise<{ ok: true; source: AuthoritativeSource; text: string } | { ok: false; reason: DropReason }> {
  if (!isChunkSourceType(row.source_type)) throw new SecurityViolation("unknown_kind");
  const source = await scope.readSource(row.source_type, row.source_id);
  if (!source) {
    if (await scope.sourceExistsElsewhere(row.source_type, row.source_id)) throw new SecurityViolation("source_owner_mismatch");
    return { ok: false, reason: "source_missing" };
  }
  const { span_start: start, span_end: end } = row;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.text.length) {
    return { ok: false, reason: "hash_mismatch_same_owner" };
  }
  const text = source.text.slice(start, end);
  if (sha256(text) !== row.content_hash) return { ok: false, reason: "hash_mismatch_same_owner" };
  return { ok: true, source, text };
}

/**
 * 원시 결과 묶음 → ValidatedResult. 하나라도 보안 위반이면 SecurityViolation(묶음 전체를 버린다).
 * 반환 객체는 scope.validated(WeakSet)에 등록된다 — renderForLlm·issue는 그 안의 객체만 받는다.
 */
export async function validateBatch(scope: ValidationScope, raw: readonly RawItem[]): Promise<ValidatedResult> {
  const s = scope.snapshot;
  const principal = scope.ctx.principalUserId;
  if (!principal || s.principalUserId !== principal) throw new SecurityViolation("unowned_node");
  const items: ValidatedItem[] = [];
  const dropped: { reason: DropReason }[] = [];

  for (const r of raw) {
    switch (r?.kind) {
      case "node": {
        checkNode(s, r.id, r.label);
        // raw에 props가 붙어 오면(실행기·검색기가 값을 실어 보냄) 스냅샷 해시와 같아야 한다. 값은 어차피 스냅샷에서 다시 꺼낸다.
        if (r.props !== undefined && allowedPropsHash(s.nodes.get(r.id)!.label, r.props) !== s.nodes.get(r.id)!.hash) {
          dropped.push({ reason: "stale_version" });
          break;
        }
        items.push(nodeItem(s, r.id, { meta: safeMeta(r.meta) }));
        break;
      }
      case "node-detail": {
        const parent = scope.registry.get(r.evidenceId);
        if (!parent || parent.kind !== "node") {
          dropped.push({ reason: "not_found" });
          break;
        }
        if (!s.nodes.has(parent.sourceKey)) throw new SecurityViolation("foreign_node");
        if (s.nodes.get(parent.sourceKey)!.hash !== parent.version) {
          dropped.push({ reason: "stale_version" });
          break;
        }
        const it = nodeItem(s, parent.sourceKey, { full: true });
        items.push({ ...it, sourceKey: parent.sourceKey, version: `${parent.version}:full` });
        break;
      }
      case "edge": {
        const k = checkEdge(s, r);
        if (!isRel(r.type)) throw new SecurityViolation("foreign_edge");
        items.push({
          kind: "edge",
          sourceKey: k,
          version: sha256(k),
          content: edgeBody(s, r.from, r.type, r.to),
          inputIds: [r.from, r.to],
          display: { label: "관계", name: edgeBody(s, r.from, r.type, r.to).slice(0, 120), snippet: "" },
        });
        break;
      }
      case "path": {
        if (!Array.isArray(r.nodes) || !Array.isArray(r.edges) || r.nodes.length !== r.edges.length + 1) throw new SecurityViolation("unknown_kind");
        for (const n of r.nodes) checkNode(s, n.id, n.label);
        const keys = r.edges.map((e) => checkEdge(s, e));
        // 경로의 각 간선이 앞뒤 노드를 실제로 잇는지.
        r.edges.forEach((e, i) => {
          const a = r.nodes[i]!.id;
          const b = r.nodes[i + 1]!.id;
          if (!((e.from === a && e.to === b) || (e.from === b && e.to === a))) throw new SecurityViolation("foreign_edge");
        });
        const ids = r.nodes.map((n) => n.id);
        const body = pathBody(s, ids, keys);
        items.push({
          kind: "path",
          sourceKey: keys.join(">") || ids[0]!,
          version: sha256(canonicalJson(ids.map((id) => s.nodes.get(id)!.hash))),
          content: body,
          inputIds: ids,
          display: { label: "경로", name: s.nodes.get(ids.at(-1)!)!.title, snippet: "", pathText: body.replace(/^경로: /, "") },
        });
        break;
      }
      case "aggregate": {
        if (!r.plan || r.plan.validated !== true || r.plan.ret.kind !== "aggregate" || !Array.isArray(r.groups)) throw new SecurityViolation("unknown_kind");
        for (const g of r.groups) for (const id of g.inputIds ?? []) if (!s.nodes.has(id)) throw new SecurityViolation("aggregate_mismatch");
        // 같은 계획을 같은 스냅샷 위에서 다시 계산한 값과 같아야 한다(실행기를 바꿔 끼운 경우까지).
        const again = evalPlan(r.plan, s);
        if (again.kind !== "aggregate" || !sameGroups(again.groups, r.groups)) throw new SecurityViolation("aggregate_mismatch");
        const inputIds = [...new Set(again.groups.flatMap((g) => g.inputIds))].sort();
        const body = aggregateBody(s, r.plan, again.groups);
        items.push({
          kind: "aggregate",
          sourceKey: `agg:${sha256(canonicalJson({ v: r.plan.vars, h: r.plan.hops, f: r.plan.filters, r: r.plan.ret }))}`,
          version: sha256(canonicalJson(again.groups)),
          content: body,
          inputIds,
          aggregate: { plan: r.plan, groups: again.groups },
          display: { label: "집계", name: body.split("\n")[0]!.slice(0, 120), snippet: body.split("\n").slice(1).join(", ").slice(0, 200) },
        });
        break;
      }
      case "chunk": {
        const row = r.row;
        // ① 검색 SQL이 본인 범위로 좁혔는지(1차). 비었거나 다르면 보안 실패.
        if (!row || typeof row.user_id !== "string" || row.user_id.length === 0 || row.user_id !== principal) {
          throw new SecurityViolation("chunk_owner_mismatch");
        }
        const v = await verifyChunkSource(scope, row);
        if (!v.ok) {
          dropped.push({ reason: v.reason });
          break;
        }
        // ⑤ 연결 노드는 지금 스냅샷에 있는 것만.
        const linked = (Array.isArray(row.node_ids) ? row.node_ids : []).filter((id) => typeof id === "string" && s.nodes.has(id));
        const shown = v.text.length > CHUNK_RENDER_MAX ? `${v.text.slice(0, CHUNK_RENDER_MAX)}…` : v.text;
        items.push({
          kind: "chunk",
          sourceKey: row.id,
          version: row.content_hash,
          content: chunkBody(v.source.label, shown),
          inputIds: [row.id, ...linked],
          linkedNodeIds: linked,
          chunk: {
            chunkId: row.id,
            sourceType: v.source.sourceType,
            sourceId: v.source.sourceId,
            sourceVersion: v.source.version,
            spanStart: row.span_start,
            spanEnd: row.span_end,
            contentHash: row.content_hash,
          },
          display: { label: labelOfSource(v.source.sourceType), name: v.source.label, snippet: safeText(shown, 200), sourceType: v.source.sourceType },
        });
        break;
      }
      case "source-span": {
        const parent = scope.registry.get(r.parentEvidenceId);
        if (!parent || parent.kind !== "chunk" || !parent.chunk) {
          dropped.push({ reason: "not_found" });
          break;
        }
        const c = parent.chunk;
        const v = await verifyChunkSource(scope, {
          source_type: c.sourceType,
          source_id: c.sourceId,
          span_start: c.spanStart,
          span_end: c.spanEnd,
          content_hash: c.contentHash,
        });
        if (!v.ok) {
          dropped.push({ reason: "not_found" });
          break;
        }
        const window = Math.max(0, Math.min(1200, Math.floor(r.window)));
        const start = Math.max(0, c.spanStart - window);
        const end = Math.min(v.source.text.length, c.spanEnd + window, start + 2400);
        const text = v.source.text.slice(start, end);
        items.push({
          kind: "source-span",
          sourceKey: `${c.sourceType}:${c.sourceId}:${start}-${end}`,
          version: sha256(text),
          content: chunkBody(`${v.source.label} (원문 ${start}–${end})`, text),
          inputIds: [c.chunkId],
          span: { sourceType: c.sourceType, sourceId: c.sourceId, sourceVersion: v.source.version, start, end, hash: sha256(text), parentEvidenceId: parent.evidenceId },
          display: { label: labelOfSource(c.sourceType), name: v.source.label, snippet: safeText(text, 200), sourceType: c.sourceType },
        });
        break;
      }
      case "derived": {
        const inputs: Evidence[] = [];
        for (const id of r.inputEvidenceIds ?? []) {
          const ev = scope.registry.get(id);
          if (!ev) throw new SecurityViolation("derived_foreign_input");
          inputs.push(ev);
        }
        // 1단계에는 파생 결과를 만드는 도구가 없다 — 입력만 확인하고, 결과는 입력 근거의 본문을 묶은 것으로만 만든다.
        const body = safeText(`${r.op === "timeline" ? "시간순 정리" : "요약"}\n${inputs.map((e) => e.display.name).join("\n")}`);
        items.push({
          kind: "derived",
          sourceKey: `derived:${r.op}:${inputs.map((e) => e.evidenceId).sort().join(",")}`,
          version: sha256(body),
          content: body,
          inputIds: [...new Set(inputs.flatMap((e) => e.inputIds))],
          display: { label: "파생", name: r.op, snippet: "" },
        });
        break;
      }
      default:
        throw new SecurityViolation("unknown_kind");
    }
  }
  const result = Object.freeze({ items: Object.freeze(items), dropped: Object.freeze(dropped) }) as unknown as ValidatedResult;
  scope.validated.add(result);
  return result;
}

const labelOfSource = (t: ChunkSourceType) => (t === "repo-brief" ? "GitHub 저장소 요약" : t === "document-import" ? "가져온 문서" : "포트폴리오");

/** 최종 검증·조회 재검증용: 청크/원문 구간 근거가 지금도 같은지(요청 캐시 없이 새로 읽음). */
export async function chunkStillValid(
  read: (t: ChunkSourceType, id: string) => Promise<AuthoritativeSource | null>,
  ref: { sourceType: ChunkSourceType; sourceId: string; start: number; end: number; hash: string },
): Promise<boolean> {
  const src = await read(ref.sourceType, ref.sourceId);
  if (!src || ref.end > src.text.length) return false;
  return sha256(src.text.slice(ref.start, ref.end)) === ref.hash;
}
