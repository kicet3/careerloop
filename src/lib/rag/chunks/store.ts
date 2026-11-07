import "server-only";
/**
 * 청크 저장소 SQL(§6.2). 이 모듈의 모든 SQL 문장에는 `user_id =` 조건이 있다(store.sql.test.ts가 확인).
 * 검색은 MATERIALIZED CTE가 user_id로 먼저 좁힌 뒤 FTS 순위를 매긴다 — 전역 top-k 뒤 앱에서 거르는 방식을 쓰지 않는다.
 * 검색 결과에는 content가 없다(LLM에 보일 텍스트는 검증기가 권위 원문에서 다시 자른다, §7.3).
 */
import { Prisma, prisma } from "@/lib/db/client";
import type { AuthContext } from "../auth-context";
import { sha256 } from "../hash";
import { bumpDataVersion } from "../versions";
import { type ChunkSourceType, sanitizeLexeme } from "./build";

export interface ChunkRow {
  id: string;
  user_id: string;
  source_type: string;
  source_id: string;
  source_version: string;
  span_start: number;
  span_end: number;
  node_ids: string[];
  content_hash: string;
  rank?: number;
}

export interface ChunkQuery {
  lexemes: string[];
  /** 본인 스냅샷에 있는 노드 id만(빈 배열이면 SQL 없이 0건 — "범위 없음"으로 넓어지지 않게). */
  nodeIds?: string[];
  sourceTypes?: ChunkSourceType[];
  limit: number;
}

export const SEARCH_STATEMENT_TIMEOUT = "3000ms";

/**
 * 검색 SQL 문장(실행하는 그 문장 — store.test.ts가 이 문장으로 EXPLAIN을 본다). 범위가 비면(lexeme 0개·노드/출처 목록이 빈 배열) null:
 * SQL을 실행하지 않는다("범위 없음"이 "전체"로 넓어지지 않게).
 */
export function searchChunksQuery(principal: string, q: ChunkQuery): Prisma.Sql | null {
  if (!principal) return null;
  const lexemes = [...new Set(q.lexemes.map(sanitizeLexeme).filter(Boolean))].slice(0, 32);
  if (lexemes.length === 0) return null;
  if (q.nodeIds && q.nodeIds.length === 0) return null;
  if (q.sourceTypes && q.sourceTypes.length === 0) return null;
  const limit = Math.max(1, Math.min(q.limit, 8)) * 2;
  return Prisma.sql`
      WITH mine AS MATERIALIZED (
        SELECT id, user_id, source_type, source_id, source_version, span_start, span_end, node_ids, content_hash, tsv
        FROM experience_chunks
        WHERE user_id = ${principal}
          ${q.nodeIds ? Prisma.sql`AND node_ids && ${q.nodeIds}::text[]` : Prisma.empty}
          ${q.sourceTypes ? Prisma.sql`AND source_type = ANY(${q.sourceTypes}::text[])` : Prisma.empty}
      ), query AS (
        SELECT to_tsquery('simple', array_to_string(${lexemes}::text[], ' | ')) AS q
      )
      SELECT m.id, m.user_id, m.source_type, m.source_id, m.source_version, m.span_start, m.span_end,
             m.node_ids, m.content_hash, ts_rank_cd(m.tsv, query.q)::float8 AS rank
      FROM mine m, query
      WHERE m.tsv @@ query.q
      ORDER BY rank DESC, m.id
      LIMIT ${limit}`;
}

export async function searchChunksSql(ctx: Pick<AuthContext, "principalUserId">, q: ChunkQuery): Promise<ChunkRow[]> {
  const sql = searchChunksQuery(ctx.principalUserId, q);
  if (!sql) return [];
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${SEARCH_STATEMENT_TIMEOUT}'`);
    const rows = await tx.$queryRaw<ChunkRow[]>(sql);
    return rows.map((r) => ({ ...r, rank: Number(r.rank) }));
  });
}

/** 인용 재검증용: 본인 청크만(id 목록). */
export async function getChunksByIds(principalUserId: string, ids: readonly string[]): Promise<ChunkRow[]> {
  if (!principalUserId || ids.length === 0) return [];
  return prisma.$queryRaw<ChunkRow[]>`
    SELECT id, user_id, source_type, source_id, source_version, span_start, span_end, node_ids, content_hash
    FROM experience_chunks WHERE user_id = ${principalUserId} AND id = ANY(${[...ids]}::text[])`;
}

export async function countUserChunks(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ c: number }[]>`SELECT count(*)::int AS c FROM experience_chunks WHERE user_id = ${userId}`;
  return Number(rows[0]?.c ?? 0);
}

/** 이 사용자의 청크가 있는 출처(재색인 정리용). */
export async function listChunkSources(userId: string): Promise<{ source_type: string; source_id: string }[]> {
  return prisma.$queryRaw<{ source_type: string; source_id: string }[]>`
    SELECT DISTINCT source_type, source_id FROM experience_chunks WHERE user_id = ${userId}`;
}

export interface NewChunk {
  ordinal: number;
  spanStart: number;
  spanEnd: number;
  nodeIds: string[];
  content: string;
  contentHash: string;
  searchTerms: string;
}

/**
 * 청크 id: 사용자·출처·순번·구간 해시에서 결정적으로 만든다. 같은 글을 다시 색인하면 id가 그대로라 진행 중인 요청의 최종 검증과
 * 저장된 인용이 깨지지 않는다(글이 바뀐 청크만 새 id).
 */
export function chunkId(userId: string, sourceType: ChunkSourceType, sourceId: string, ordinal: number, contentHash: string): string {
  return "ch_" + sha256(`${userId}|${sourceType}|${sourceId}|${ordinal}|${contentHash}`).slice(0, 22);
}

/** 출처 하나의 청크를 통째로 바꾼다(한 트랜잭션). 호출자는 sync.ts뿐이다(원문은 sync가 출처 재조회로 직접 읽는다). tsv는 여기서 계산해 넣는다. */
export async function replaceSourceChunks(
  userId: string,
  sourceType: ChunkSourceType,
  sourceId: string,
  sourceVersion: string,
  chunks: readonly NewChunk[],
): Promise<void> {
  if (!userId) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM experience_chunks WHERE user_id = ${userId} AND source_type = ${sourceType} AND source_id = ${sourceId}`;
    for (const c of chunks) {
      const id = chunkId(userId, sourceType, sourceId, c.ordinal, c.contentHash);
      await tx.$executeRaw`
        INSERT INTO experience_chunks (id, user_id, source_type, source_id, source_version, ordinal, span_start, span_end, node_ids, content, content_hash, search_terms, tsv)
        SELECT ${id}, u.id, ${sourceType}, ${sourceId}, ${sourceVersion}, ${c.ordinal}, ${c.spanStart}, ${c.spanEnd},
               ${c.nodeIds}::text[], ${c.content}, ${c.contentHash}, ${c.searchTerms}, to_tsvector('simple', ${c.searchTerms})
        FROM users u WHERE u.id = ${userId}`;
    }
  });
  await bumpDataVersion(userId);
}

export async function deleteChunksBySource(userId: string, sourceType: ChunkSourceType, sourceId: string): Promise<number> {
  if (!userId) return 0;
  const n = await prisma.$executeRaw`DELETE FROM experience_chunks WHERE user_id = ${userId} AND source_type = ${sourceType} AND source_id = ${sourceId}`;
  if (n > 0) await bumpDataVersion(userId);
  return n;
}

/** 노드 삭제: 그 노드 id를 청크 연결에서 뺀다. 실패해도 검증기가 스냅샷에 없는 id를 걸러 낸다. */
export async function removeNodesFromChunks(userId: string, nodeIds: readonly string[]): Promise<void> {
  if (!userId || nodeIds.length === 0) return;
  const ids = [...nodeIds];
  const n = await prisma.$executeRaw`
    UPDATE experience_chunks
    SET node_ids = ARRAY(SELECT x FROM unnest(node_ids) AS x WHERE NOT (x = ANY(${ids}::text[]))), updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ${userId} AND node_ids && ${ids}::text[]`;
  if (n > 0) await bumpDataVersion(userId);
}
