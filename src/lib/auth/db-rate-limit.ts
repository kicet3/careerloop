import "server-only";
/**
 * DB(rate_events)에 기록하는 레이트 리밋. 메모리 리밋(rate-limit.ts)은 인스턴스마다 따로 세고 서버리스에서는 인스턴스가
 * 자주 바뀌어 긴 창(24시간)이 사실상 지켜지지 않으므로, 비용이 드는 기능(AI 초안·그래프 채팅·IP당 진단)은 여기서 센다.
 * 확인과 기록을 한 트랜잭션에서 하고, 같은 (bucket, key)는 트랜잭션 단위 advisory lock으로 줄 세운다 — Postgres의
 * READ COMMITTED에서는 "개수 세고 INSERT"를 한 문장으로 써도 동시 트랜잭션이 함께 통과할 수 있기 때문이다.
 * (pg_advisory_xact_lock은 트랜잭션이 끝나면 풀리므로 Supabase Transaction pooler에서도 안전하다.)
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";

export type DbRateLimit = { bucket: string; limit: number; windowMs: number };

/** AI 이력서 초안: 사용자당 24시간 30회. */
export const RESUME_DRAFT_LIMIT: DbRateLimit = { bucket: "resume-draft", limit: 30, windowMs: 24 * 60 * 60_000 };
/** 그래프 채팅 전송·재시도: 사용자당 10분 30회. */
export const GRAPH_CHAT_LIMIT: DbRateLimit = { bucket: "graph-chat", limit: 30, windowMs: 10 * 60_000 };
/** 진단 생성: IP당 24시간 20건(계정을 여러 개 만들어 하루 제한을 우회하는 것을 늦춘다). */
export const DIAGNOSIS_IP_LIMIT: DbRateLimit = { bucket: "diagnosis-ip", limit: 20, windowMs: 24 * 60 * 60_000 };

/** IP는 원문 대신 해시로 저장한다. */
export function ipKey(ip: string): string {
  return createHash("sha256").update(`ip:${ip}`).digest("base64url").slice(0, 32);
}

/** 시도 1회를 기록하고 허용 여부를 돌려준다. 한도를 넘으면 기록하지 않는다. */
export async function hitDbLimit(
  rule: DbRateLimit,
  key: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const since = new Date(now - rule.windowMs);
  const where = { bucket: rule.bucket, key };
  const oldest = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rate:${rule.bucket}:${key}`}, 0))`;
    // 창이 지난 기록은 지운다(같은 키만 — 인덱스로 좁힌다).
    await tx.rateEvent.deleteMany({ where: { ...where, createdAt: { lte: since } } });
    const agg = await tx.rateEvent.aggregate({
      where: { ...where, createdAt: { gt: since } },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    if (agg._count._all < rule.limit) {
      await tx.rateEvent.create({ data: { ...where, createdAt: new Date(now) } });
      return null;
    }
    return agg._min.createdAt ?? new Date(now);
  });
  if (!oldest) return { ok: true, retryAfterSec: 0 };
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest.getTime() + rule.windowMs - now) / 1000)) };
}
