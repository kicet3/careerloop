import "server-only";
/**
 * 문서 재색인 진입점(§6.3) — 사용자 '문서 다시 색인'(하루 3회)과 관리자 일괄 재색인. 질문 경로(after())에서는 부르지 않는다.
 */
import { hitDbLimit, type DbRateLimit } from "@/lib/auth/db-rate-limit";
import { prisma } from "@/lib/db/client";
import { reindexUser } from "./chunks/sync";

/** 사용자 재색인: 사용자당 24시간 3회. */
export const RAG_REINDEX_LIMIT: DbRateLimit = { bucket: "rag-reindex", limit: 3, windowMs: 24 * 60 * 60_000 };

export async function reindexOwn(
  userId: string,
  now = Date.now(),
): Promise<{ ok: true; synced: number; deleted: number; done: boolean } | { ok: false; retryAfterSec: number }> {
  const limit = await hitDbLimit(RAG_REINDEX_LIMIT, userId, now);
  if (!limit.ok) return { ok: false, retryAfterSec: limit.retryAfterSec };
  const r = await reindexUser(userId, {}, { deadlineAt: now + 250_000 });
  return { ok: true, synced: r.synced, deleted: r.deleted, done: r.done };
}

/**
 * 관리자 일괄: id 순으로 cursor 다음 사용자부터 마감 전까지. 다 못 하면 nextCursor(마지막으로 끝까지 마친 사용자 — 다음 호출은 그 다음부터).
 * 한 사용자를 마감 안에 다 못 하면 그 사용자를 건너뛰지 않는다: nextCursor는 그 앞 사용자이고 partialUserId로 알린다.
 */
export async function reindexAll(opts: {
  cursor?: string | null;
  userId?: string | null;
  deadlineAt: number;
}): Promise<{ processed: number; nextCursor: string | null; partialUserId?: string; done: boolean }> {
  if (opts.userId) {
    const r = await reindexUser(opts.userId, {}, { deadlineAt: opts.deadlineAt });
    return r.done ? { processed: 1, nextCursor: null, done: true } : { processed: 0, nextCursor: null, partialUserId: opts.userId, done: false };
  }
  let processed = 0;
  let cursor = opts.cursor ?? null;
  for (;;) {
    const batch = await prisma.user.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: "asc" },
      select: { id: true },
      take: 20,
    });
    if (batch.length === 0) return { processed, nextCursor: null, done: true };
    for (const u of batch) {
      if (Date.now() > opts.deadlineAt) return { processed, nextCursor: cursor ?? "", done: false };
      const r = await reindexUser(u.id, {}, { deadlineAt: opts.deadlineAt });
      // 마감으로 중간에 멈춘 사용자: cursor를 넘기지 않는다(다음 호출이 이 사용자부터 다시).
      if (!r.done) return { processed, nextCursor: cursor ?? "", partialUserId: u.id, done: false };
      processed++;
      cursor = u.id;
    }
  }
}
