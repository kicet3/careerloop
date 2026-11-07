import "server-only";
/**
 * 사용자별 권한·데이터 버전(user_rag_state, §3.1). 행이 없으면 모두 1(지연 생성).
 * - 권한 버전은 DB 트리거가 올린다(계정 상태·비밀번호·동의 기록 — 그 변경과 같은 트랜잭션). bumpPolicyVersion은 앱에서 직접 올릴 때만.
 * - 데이터 버전은 그래프 쓰기(Neo4j 성공 직후, graph/service.ts)·청크 변경(store.ts)·출처 변경(트리거)에서 오른다.
 * 버전은 캐시 무효화와 빠른 중단에만 쓴다. 최종 판단은 권위 레코드 재조회(스냅샷 재로딩·출처 재조회)다(§7).
 */
import { prisma } from "@/lib/db/client";

export interface RagState {
  policyVersion: number;
  dataVersion: bigint;
  sourceVersion: bigint;
  indexedSourceVersion: bigint;
}

const DEFAULT_STATE: RagState = Object.freeze({ policyVersion: 1, dataVersion: BigInt(1), sourceVersion: BigInt(1), indexedSourceVersion: BigInt(1) });

export async function readRagState(userId: string): Promise<RagState> {
  const row = await prisma.userRagState.findUnique({ where: { userId } });
  if (!row) return DEFAULT_STATE;
  return {
    policyVersion: row.policyVersion,
    dataVersion: row.dataVersion,
    sourceVersion: row.sourceVersion,
    indexedSourceVersion: row.indexedSourceVersion,
  };
}

async function bump(userId: string, policy: boolean, source: boolean): Promise<void> {
  if (!userId) return;
  await prisma.$executeRaw`SELECT rag_bump(${userId}::text, ${policy}::boolean, ${source}::boolean)`;
}

export const bumpDataVersion = (userId: string) => bump(userId, false, false);
export const bumpPolicyVersion = (userId: string) => bump(userId, true, false);
export const bumpSourceVersion = (userId: string) => bump(userId, false, true);

/** 전체 재색인이 끝남: 시작 시점에 읽은 출처 버전까지 색인했다. */
export async function markIndexed(userId: string, sourceVersion: bigint): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "user_rag_state" SET "indexed_source_version" = GREATEST("indexed_source_version", ${sourceVersion}::bigint), "updated_at" = CURRENT_TIMESTAMP
    WHERE "user_id" = ${userId}`;
}

/** 출처 하나를 바로 동기화함: 색인 버전을 1 올린다(출처 버전을 넘지 않게). 대략값이고 전체 재색인이 정확한 값으로 맞춘다. */
export async function markOneSourceIndexed(userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "user_rag_state" SET "indexed_source_version" = LEAST("source_version", "indexed_source_version" + 1), "updated_at" = CURRENT_TIMESTAMP
    WHERE "user_id" = ${userId}`;
}
