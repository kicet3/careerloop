/**
 * 최종 답변 검증(§8.4, 결정적). 저장(=사용자에게 처음 보이는 시점) 전에:
 * 1) 권한 버전이 그대로인지(바뀌면 PolicyChangedError로 중단)
 * 2) 인용 근거가 지금도 접근 가능한지 — 스냅샷을 고정 템플릿으로 한 번 더 읽고, 청크·원문 구간은 요청 캐시 없이 출처를 새로 읽는다
 * 3) segment마다: 발급된 id(이 요청·이 사용자·HMAC 일치)만, fact는 유효 인용 1개 이상, 수치·날짜·이름 후보가 인용 근거 본문에 있을 것
 *    advice는 인용 없어도 되지만 수치·날짜·본인 노드 이름을 담으면 fact 규칙, gap은 인용 없이 이름 후보 없을 것
 * 4) 남은 fact가 0인데 원래 fact가 있었으면 고정 안내(insufficient)
 * 소유권 판단에 LLM을 쓰지 않는다. 보조 함의 검사(선택)는 덜어내기에만 쓴다.
 */
import { assertContextCurrent } from "./auth-context";
import type { AuthoritativeSource } from "./chunks/authoritative";
import type { ChunkSourceType } from "./chunks/build";
import type { ChunkRow } from "./chunks/store";
import { extractClaims, hasClaims, indexEvidence, normalizeText, unsupportedClaim } from "./claims";
import { evalPlan } from "./graph/eval-in-memory";
import { canonicalJson, sha256 } from "./hash";
import type { ValidatedPlan } from "./graph/plan";
import type { Evidence } from "./registry";
import type { RequestScope } from "./scope";
import { buildOwnedSnapshot, type GraphLoader, type OwnedSnapshot } from "./snapshot";
import { chunkStillValid } from "./validator";

export interface FinalSegmentInput {
  text: string;
  kind: "fact" | "advice" | "gap";
  evidenceIds: string[];
}

export interface ValidSegment {
  text: string;
  kind: "fact" | "advice" | "gap";
  evidence: Evidence[];
}

export type SegmentDropReason = "invalid_evidence" | "no_citation" | "unsupported_claim" | "gap_with_claim" | "stale_evidence" | "entailment";

export interface FinalCheck {
  segments: ValidSegment[];
  dropped: { reason: SegmentDropReason | "invalid_evidence" }[];
  /** 원래 fact가 있었는데 하나도 남지 않음. */
  allFactsDropped: boolean;
  /** 최종 검증에 쓴 새 스냅샷(이름 사전·제안용). */
  fresh: OwnedSnapshot;
  dataChanged: boolean;
}

export interface FinalDeps {
  loadGraph: GraphLoader;
  readSourceFresh(principal: string, t: ChunkSourceType, id: string): Promise<AuthoritativeSource | null>;
  getChunksByIds(principal: string, ids: readonly string[]): Promise<ChunkRow[]>;
}

/** 그래프 기반 근거(노드·관계·경로·집계)의 재검증 입력 — 저장된 인용(citations.ts)도 같은 규칙을 쓴다. */
export interface GraphRef {
  kind: "node" | "edge" | "path" | "aggregate";
  sourceKey: string;
  version: string;
  inputIds: readonly string[];
  aggregatePlan?: ValidatedPlan | null;
}

/**
 * 그래프 기반 근거가 새 스냅샷에서 아직 같은가: 노드는 허용 속성 해시, 관계는 간선 키, 경로는 모든 간선 키 + 노드 해시들의 해시,
 * 집계는 같은 계획을 새 스냅샷에서 다시 계산한 그룹의 해시. 계획이 없는 집계는 false(fail-closed).
 */
export function graphRefStillValid(ref: GraphRef, fresh: OwnedSnapshot): boolean {
  switch (ref.kind) {
    case "node":
      return fresh.nodes.get(ref.sourceKey)?.hash === ref.version.replace(/:full$/, "");
    case "edge":
      return fresh.edgeKeys.has(ref.sourceKey);
    case "path": {
      if (!ref.inputIds.every((id) => fresh.nodes.has(id))) return false;
      const edges = ref.sourceKey.includes("|") ? ref.sourceKey.split(">") : [];
      if (!edges.every((k) => fresh.edgeKeys.has(k))) return false;
      return sha256(canonicalJson(ref.inputIds.map((id) => fresh.nodes.get(id)!.hash))) === ref.version;
    }
    case "aggregate": {
      if (!ref.aggregatePlan) return false;
      try {
        const again = evalPlan(ref.aggregatePlan, fresh);
        return again.kind === "aggregate" && sha256(canonicalJson(again.groups)) === ref.version;
      } catch {
        return false;
      }
    }
  }
}

/** 근거 하나가 새 스냅샷·새 출처 기준으로 아직 같은가. */
export async function evidenceStillValid(ev: Evidence, fresh: OwnedSnapshot, deps: FinalDeps, chunkRows: Map<string, ChunkRow>): Promise<boolean> {
  const principal = fresh.principalUserId;
  switch (ev.kind) {
    case "node":
    case "edge":
    case "path":
    case "aggregate":
      return graphRefStillValid({ kind: ev.kind, sourceKey: ev.sourceKey, version: ev.version, inputIds: ev.inputIds, aggregatePlan: ev.aggregate?.plan ?? null }, fresh);
    case "chunk": {
      const c = ev.chunk;
      const row = c ? chunkRows.get(c.chunkId) : undefined;
      if (!c || !row || row.content_hash !== c.contentHash || row.user_id !== principal) return false;
      return chunkStillValid((t, id) => deps.readSourceFresh(principal, t, id), {
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        start: c.spanStart,
        end: c.spanEnd,
        hash: c.contentHash,
      });
    }
    case "source-span": {
      const sp = ev.span;
      if (!sp) return false;
      return chunkStillValid((t, id) => deps.readSourceFresh(principal, t, id), {
        sourceType: sp.sourceType,
        sourceId: sp.sourceId,
        start: sp.start,
        end: sp.end,
        hash: sp.hash,
      });
    }
    case "derived":
      return false;
  }
}

export async function finalValidate(scope: RequestScope, segments: readonly FinalSegmentInput[], deps: FinalDeps): Promise<FinalCheck> {
  const { dataChanged } = await assertContextCurrent(scope.ctx);
  const principal = scope.ctx.principalUserId;
  const fresh = buildOwnedSnapshot(await deps.loadGraph(principal), principal);
  const dropped: FinalCheck["dropped"] = [];

  // 인용된 근거: 이 요청 레지스트리에서 발급 + HMAC 일치 + 같은 요청·사용자.
  const cited = new Map<string, Evidence>();
  for (const seg of segments) {
    for (const id of seg.evidenceIds) {
      const ev = scope.registry.get(id);
      if (ev && ev.principalUserId === principal && ev.requestId === scope.ctx.requestId) cited.set(id, ev);
    }
  }
  const chunkIds = [...cited.values()].flatMap((e) => (e.kind === "chunk" && e.chunk ? [e.chunk.chunkId] : []));
  const chunkRows = new Map((await deps.getChunksByIds(principal, chunkIds)).map((r) => [r.id, r]));
  const live = new Set<string>();
  for (const [id, ev] of cited) if (await evidenceStillValid(ev, fresh, deps, chunkRows)) live.add(id);

  const titles = [...fresh.nodes.values(), ...scope.snapshot.nodes.values()].filter((n) => n.label !== "Person").map((n) => n.title);
  const titleHit = (text: string) => {
    const flat = normalizeText(text);
    return titles.some((t) => normalizeText(t).length >= 2 && flat.includes(normalizeText(t)));
  };

  const out: ValidSegment[] = [];
  let hadFact = false;
  for (const seg of segments) {
    const valid: Evidence[] = [];
    for (const id of seg.evidenceIds) {
      if (!cited.has(id)) {
        dropped.push({ reason: "invalid_evidence" });
        continue;
      }
      if (!live.has(id)) {
        dropped.push({ reason: "stale_evidence" });
        continue;
      }
      if (!valid.includes(cited.get(id)!)) valid.push(cited.get(id)!);
    }
    const claims = extractClaims(seg.text, titles);
    let kind = seg.kind;
    if (kind === "gap") {
      // gap(없다는 말)은 근거를 달 수 없으므로 수치·날짜·이름 후보(본인 노드 이름·기술명·라틴 고유명사·따옴표)를 하나도 담지 않아야 한다(§8.4).
      if (seg.evidenceIds.length > 0 || titleHit(seg.text) || hasClaims(claims)) {
        dropped.push({ reason: "gap_with_claim" });
        continue;
      }
      out.push({ text: seg.text, kind, evidence: [] });
      continue;
    }
    if (kind === "advice" && (claims.numbers.length > 0 || claims.dates.length > 0 || titleHit(seg.text))) kind = "fact";
    if (kind === "advice") {
      out.push({ text: seg.text, kind, evidence: valid });
      continue;
    }
    hadFact = true;
    if (valid.length === 0) {
      dropped.push({ reason: "no_citation" });
      continue;
    }
    if (hasClaims(claims) && unsupportedClaim(claims, indexEvidence(valid.map((e) => e.content)))) {
      dropped.push({ reason: "unsupported_claim" });
      continue;
    }
    out.push({ text: seg.text, kind: "fact", evidence: valid });
  }
  const factsLeft = out.some((s) => s.kind === "fact");
  return { segments: out, dropped, allFactsDropped: hadFact && !factsLeft, fresh, dataChanged };
}

/**
 * missingInfo(LLM이 고른 "더 넣으면 좋을 정보")도 근거 없이 저장·표시되므로 gap 규칙을 쓴다: 수치·날짜가 있으면 버리고,
 * 이름 후보는 본인 스냅샷에 있는 이름(노드 제목·기술 노드)일 때만 둔다 — "2021년 Google 인턴 기간" 같은 지어낸 구체 정보를 막는다.
 */
export function filterMissingInfo(items: readonly string[], fresh: OwnedSnapshot): string[] {
  const titles = [...fresh.nodes.values()].filter((n) => n.label !== "Person").map((n) => n.title);
  const known = titles.map(normalizeText).filter((t) => t.length >= 2);
  const out: string[] = [];
  for (const raw of items) {
    const text = raw.trim();
    if (!text) continue;
    const c = extractClaims(text, titles);
    if (c.numbers.length > 0 || c.dates.length > 0) continue;
    if (!c.names.every((name) => known.some((t) => t.includes(normalizeText(name))))) continue;
    out.push(text);
  }
  return out.slice(0, 3);
}
