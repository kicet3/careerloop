import "server-only";
/**
 * DB(rate_events)에 기록하는 레이트 리밋. 메모리 리밋(rate-limit.ts)은 인스턴스마다 따로 세고 서버리스에서는 인스턴스가
 * 자주 바뀌어 긴 창(24시간)이 사실상 지켜지지 않으므로, 비용이 드는 기능(AI 초안·그래프 채팅·IP당 진단)은 여기서 센다.
 * 확인과 기록을 INSERT … SELECT … WHERE count < limit 한 문장으로 해서 동시 요청도 한도를 넘지 못한다.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, min, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateEvents } from "@/lib/db/schema";

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
  const since = now - rule.windowMs;
  const [, inserted] = await db.batch([
    // 창이 지난 기록은 지운다(같은 키만 — 인덱스로 좁힌다).
    db.delete(rateEvents).where(and(eq(rateEvents.bucket, rule.bucket), eq(rateEvents.key, key), sql`${rateEvents.createdAt} <= ${since}`)),
    db.all<{ id: number }>(sql`
      INSERT INTO rate_events (bucket, key, created_at)
      SELECT ${rule.bucket}, ${key}, ${now}
      WHERE (SELECT count(*) FROM rate_events WHERE bucket = ${rule.bucket} AND key = ${key} AND created_at > ${since}) < ${rule.limit}
      RETURNING id`),
  ]);
  if (inserted.length > 0) return { ok: true, retryAfterSec: 0 };
  const [row] = await db
    .select({ oldest: min(rateEvents.createdAt) })
    .from(rateEvents)
    .where(and(eq(rateEvents.bucket, rule.bucket), eq(rateEvents.key, key), gt(rateEvents.createdAt, new Date(since))));
  const oldest = row?.oldest instanceof Date ? row.oldest.getTime() : now;
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)) };
}
