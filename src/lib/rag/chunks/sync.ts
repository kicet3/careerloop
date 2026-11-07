import "server-only";
/**
 * 청크 동기화(§6.3). syncSource(userId, sourceType, sourceId)는 원문을 인자로 받지 않는다 — 출처 재조회 함수(소유 조건 포함)로 직접 읽는다.
 * 그래서 호출자가 실수로 다른 사용자의 원문을 넘겨 A 소유 청크로 저장하는 경로가 없다. 남의 출처 id를 넘기면 읽지 못해(null) 아무것도
 * 쓰지 않고, 이 사용자 이름으로 남아 있던 그 id의 청크만 지운다.
 * node_ids는 그 시점 본인 그래프(getCareerGraph 고정 템플릿)의 id와 교집합만 저장한다. 질문 경로에서는 재색인하지 않는다.
 */
import { prisma } from "@/lib/db/client";
import { ragLog } from "../log";
import { markIndexed, markOneSourceIndexed, readRagState } from "../versions";
import { readAuthoritativeSource, type SourceReader } from "./authoritative";
import { type ChunkSourceType, chunkSpans, isChunkSourceType, searchTermsOf } from "./build";
import { sha256 } from "../hash";
import { deleteChunksBySource, listChunkSources, replaceSourceChunks } from "./store";

export interface SyncDeps {
  readSource?: SourceReader;
  /** 본인 그래프 노드 id(없으면 연결 없이 저장). 기본은 graphEnabled일 때 getCareerGraph. */
  graphNodeIds?: (userId: string) => Promise<Set<string> | null>;
}

/** 그래프를 못 읽으면(저장소 꺼짐·연결 실패·3초 초과) 연결 없이 저장한다 — 원 기능을 늦추지 않는다. */
async function defaultGraphNodeIds(userId: string): Promise<Set<string> | null> {
  const { graphEnabled } = await import("@/lib/graph/client");
  if (!graphEnabled()) return null;
  const { getCareerGraph } = await import("@/lib/graph/service");
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000).unref?.());
  const g = await Promise.race([getCareerGraph(userId), timeout]);
  return g ? new Set(g.nodes.map((n) => n.id)) : null;
}

export async function syncSource(
  userId: string,
  sourceType: ChunkSourceType,
  sourceId: string,
  deps: SyncDeps = {},
  opts: { graphIds?: Set<string> | null; countAsIndexed?: boolean } = {},
): Promise<"synced" | "deleted"> {
  const read = deps.readSource ?? readAuthoritativeSource;
  const src = await read(userId, sourceType, sourceId);
  if (!src) {
    await deleteChunksBySource(userId, sourceType, sourceId);
    return "deleted";
  }
  let graphIds = opts.graphIds;
  if (graphIds === undefined) graphIds = await (deps.graphNodeIds ?? defaultGraphNodeIds)(userId).catch(() => null);
  const nodeIds = graphIds ? src.nodeCandidates.filter((id) => graphIds!.has(id)) : [];
  const chunks = chunkSpans(src.text).map((span, ordinal) => {
    const content = src.text.slice(span.start, span.end);
    return {
      ordinal,
      spanStart: span.start,
      spanEnd: span.end,
      nodeIds,
      content,
      contentHash: sha256(content),
      searchTerms: searchTermsOf(`${src.label}\n${content}`),
    };
  });
  await replaceSourceChunks(userId, sourceType, src.sourceId, src.version, chunks);
  if (opts.countAsIndexed !== false) await markOneSourceIndexed(userId);
  return "synced";
}

/** 원본을 쓴 다음 같은 요청에서 부른다. 실패해도 원 기능은 성공한다(로그만, 다음 재색인이 복구). */
export async function syncSourceSafely(
  userId: string,
  sourceType: ChunkSourceType,
  sourceId: string,
  opts: { graphIds?: Set<string> | null } = {},
): Promise<void> {
  try {
    await syncSource(userId, sourceType, sourceId, {}, opts);
  } catch (err) {
    ragLog("chunk_sync_failed", { code: sourceType, name: err instanceof Error ? err.name : "Error" });
  }
}

/** 이 사용자의 출처 목록(소유 조건으로만 찾는다). */
async function listOwnedSources(userId: string): Promise<{ type: ChunkSourceType; id: string }[]> {
  const [snapshots, portfolios, docs] = await Promise.all([
    prisma.githubRepoSnapshot.findMany({ where: { userId }, select: { id: true } }),
    prisma.portfolio.findMany({ where: { userId, textKey: { not: null } }, select: { id: true } }),
    prisma.chatMessage.findMany({
      where: { role: "user", thread: { userId }, data: { path: ["kind"], equals: "document-import" } },
      select: { id: true },
    }),
  ]);
  return [
    ...snapshots.map((r) => ({ type: "repo-brief" as const, id: r.id })),
    ...portfolios.map((r) => ({ type: "portfolio-text" as const, id: r.id })),
    ...docs.map((r) => ({ type: "document-import" as const, id: r.id })),
  ];
}

/** 사용자 전체 재색인(관리자 스크립트·사용자 '다시 색인'). 끝나면 시작 시점의 출처 버전까지 색인했다고 기록한다. */
export async function reindexUser(userId: string, deps: SyncDeps = {}, opts: { deadlineAt?: number } = {}): Promise<{ synced: number; deleted: number; done: boolean }> {
  const state = await readRagState(userId);
  const graphIds = await (deps.graphNodeIds ?? defaultGraphNodeIds)(userId).catch(() => null);
  const sources = await listOwnedSources(userId);
  const keep = new Set(sources.map((s) => `${s.type}:${s.id}`));
  let synced = 0;
  let deleted = 0;
  for (const s of sources) {
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) return { synced, deleted, done: false };
    const r = await syncSource(userId, s.type, s.id, deps, { graphIds, countAsIndexed: false });
    if (r === "synced") synced++;
    else deleted++;
  }
  for (const c of await listChunkSources(userId)) {
    if (!isChunkSourceType(c.source_type) || keep.has(`${c.source_type}:${c.source_id}`)) continue;
    await deleteChunksBySource(userId, c.source_type, c.source_id);
    deleted++;
  }
  await markIndexed(userId, state.sourceVersion);
  ragLog("reindex_done", { counts: synced, status: deleted });
  return { synced, deleted, done: true };
}
