import "server-only";
/**
 * 관리자 '사용량' 화면의 집계(llm_usage_events). 라우트·페이지는 requireAdmin()/requireAdminApiUser()로 관리자를 확인한 뒤 부른다.
 * 비용은 추정치(src/lib/llm/pricing.ts)이고, 단가를 모르는 모델·CLI 엔진 호출은 비용 합계에서 빠진다(unpricedCalls로 따로 센다).
 */
import { prisma } from "@/lib/db/client";
import type { UsageTotals } from "@/lib/domain/llm-usage";

export interface UserUsageRow extends UsageTotals {
  userId: string | null;
  email: string | null;
  name: string | null;
  lastUsedAt: number | null;
}

export interface KeyedUsageRow extends UsageTotals {
  key: string;
}

const emptyTotals = (): UsageTotals => ({
  calls: 0,
  failedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd: 0,
  unpricedCalls: 0,
});

interface RawRow {
  k: string | null;
  calls: bigint | number;
  failed: bigint | number;
  input: bigint | number | null;
  output: bigint | number | null;
  cache_read: bigint | number | null;
  cache_write: bigint | number | null;
  cost: bigint | number | string | null;
  unpriced: bigint | number;
  last_at: Date | null;
}

const num = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));

function toTotals(r: RawRow): UsageTotals {
  return {
    calls: num(r.calls),
    failedCalls: num(r.failed),
    inputTokens: num(r.input),
    outputTokens: num(r.output),
    cacheReadTokens: num(r.cache_read),
    cacheWriteTokens: num(r.cache_write),
    costMicroUsd: num(r.cost),
    unpricedCalls: num(r.unpriced),
  };
}

const AGG = `
  COUNT(*) AS calls,
  COUNT(*) FILTER (WHERE NOT ok) AS failed,
  SUM(input_tokens) AS input,
  SUM(output_tokens) AS output,
  SUM(cache_read_tokens) AS cache_read,
  SUM(cache_write_tokens) AS cache_write,
  SUM(cost_micro_usd) AS cost,
  COUNT(*) FILTER (WHERE cost_micro_usd IS NULL) AS unpriced,
  MAX(created_at) AS last_at`;

/** 그룹 키 SQL(고정 목록 — 사용자 입력이 들어가지 않는다). */
const GROUP_KEYS = {
  user: `user_id`,
  task: `CASE WHEN stage IS NULL THEN task ELSE task || ':' || stage END`,
  taskOnly: `task`,
  model: `provider || ' · ' || model`,
  day: `to_char((created_at AT TIME ZONE 'UTC') + interval '9 hours', 'YYYY-MM-DD')`,
} as const;
type GroupKey = keyof typeof GROUP_KEYS;

async function aggregate(group: GroupKey | null, opts: { since: Date | null; userId?: string | null }): Promise<RawRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    params.push(opts.since);
    where.push(`created_at >= $${params.length}`);
  }
  if (opts.userId !== undefined) {
    if (opts.userId === null) where.push(`user_id IS NULL`);
    else {
      params.push(opts.userId);
      where.push(`user_id = $${params.length}`);
    }
  }
  const keySql = group ? GROUP_KEYS[group] : `NULL::text`;
  const sql = `SELECT ${keySql} AS k, ${AGG} FROM llm_usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ${group ? `GROUP BY 1` : ""}`;
  return prisma.$queryRawUnsafe<RawRow[]>(sql, ...params);
}

const byCostDesc = <T extends UsageTotals>(a: T, b: T) =>
  b.costMicroUsd - a.costMicroUsd || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || b.calls - a.calls;

/** 사용자별 사용량(비용 많은 순)과 전체 합계. 사용자 없는 호출은 userId null 한 줄로 묶는다. */
export async function listUsageByUser(opts: { since: Date | null }): Promise<{ users: UserUsageRow[]; totals: UsageTotals }> {
  const [rows, [total]] = await Promise.all([aggregate("user", opts), aggregate(null, opts)]);
  const ids = rows.map((r) => r.k).filter((k): k is string => !!k);
  const people = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } })
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const users = rows
    .map((r): UserUsageRow => {
      const p = r.k ? byId.get(r.k) : undefined;
      return { userId: r.k, email: p?.email ?? null, name: p?.name ?? null, lastUsedAt: r.last_at ? new Date(r.last_at).getTime() : null, ...toTotals(r) };
    })
    .sort(byCostDesc);
  return { users, totals: total ? toTotals(total) : emptyTotals() };
}

/** 작업별 사용량(비용 많은 순). byStage면 심사 단계를 'diagnosis:<단계>'로 나눈다. userId를 주면 그 사용자만. */
export async function listUsageByTask(opts: { since: Date | null; userId?: string | null; byStage?: boolean }): Promise<KeyedUsageRow[]> {
  const rows = await aggregate(opts.byStage ? "task" : "taskOnly", opts);
  return rows.map((r) => ({ key: r.k ?? "", ...toTotals(r) })).sort(byCostDesc);
}

/** 엔진·모델별 사용량(비용 많은 순). */
export async function listUsageByModel(opts: { since: Date | null; userId?: string | null }): Promise<KeyedUsageRow[]> {
  const rows = await aggregate("model", opts);
  return rows.map((r) => ({ key: r.k ?? "", ...toTotals(r) })).sort(byCostDesc);
}

/** 날짜별(한국 시간, YYYY-MM-DD) 사용량 — 최근 날짜부터. */
export async function listUsageByDay(opts: { since: Date | null; userId?: string | null }): Promise<KeyedUsageRow[]> {
  const rows = await aggregate("day", opts);
  return rows.map((r) => ({ key: r.k ?? "", ...toTotals(r) })).sort((a, b) => b.key.localeCompare(a.key));
}

/** 한 사용자의 합계·작업별·날짜별·모델별 사용량. 사용자가 없으면 null(사용량만 남은 경우는 없다 — 탈퇴하면 함께 지워진다). */
export async function getUserUsage(
  userId: string,
  opts: { since: Date | null },
): Promise<{ user: { id: string; email: string; name: string | null }; totals: UsageTotals; byTask: KeyedUsageRow[]; byDay: KeyedUsageRow[]; byModel: KeyedUsageRow[] } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true } });
  if (!user) return null;
  const scope = { since: opts.since, userId };
  const [[total], byTask, byDay, byModel] = await Promise.all([
    aggregate(null, scope),
    listUsageByTask({ ...scope, byStage: true }),
    listUsageByDay(scope),
    listUsageByModel(scope),
  ]);
  return { user, totals: total ? toTotals(total) : emptyTotals(), byTask, byDay, byModel };
}

/** 경험 대화 범위 가드레일 회원별 횟수(관리자 '사용량' 화면). */
export interface ScopeGuardUserRow {
  userId: string;
  email: string | null;
  name: string | null;
  /** 기간 안 범위 밖 안내 수(off_topic + abuse). */
  total: number;
  offTopic: number;
  abuse: number;
  /** LLM 호출 전 사전 검사로 막은 수. */
  prefilter: number;
  lastAt: number | null;
  /** 지금 차단 창(scope-guard-store.ts CHAT_SCOPE_GUARD) 안의 기록 수 — limit 이상이면 지금 막혀 있다. */
  recentWindow: number;
}

/**
 * 범위 밖 안내 메시지(chat_messages.data.kind='scope-notice')를 회원별로 센다(사용자 글은 읽지 않는다). 대화를 지우면 그 기록도 빠진다.
 * recentWindow는 차단 원장(rate_events)에서 센다.
 */
export async function listScopeGuardByUser(opts: {
  since: Date | null;
  window: { bucket: string; windowMs: number };
  limit?: number;
}): Promise<ScopeGuardUserRow[]> {
  const params: unknown[] = [];
  let sinceSql = "";
  if (opts.since) {
    params.push(opts.since);
    sinceSql = `AND m.created_at >= $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const rows = await prisma.$queryRawUnsafe<
    { user_id: string; total: bigint | number; off_topic: bigint | number; abuse: bigint | number; prefilter: bigint | number; last_at: Date | null }[]
  >(
    `SELECT t.user_id,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE m.data->>'category' = 'off_topic') AS off_topic,
            COUNT(*) FILTER (WHERE m.data->>'category' = 'abuse') AS abuse,
            COUNT(*) FILTER (WHERE m.data->>'source' = 'prefilter') AS prefilter,
            MAX(m.created_at) AS last_at
       FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
      WHERE m.role = 'assistant' AND m.data->>'kind' = 'scope-notice' ${sinceSql}
      GROUP BY t.user_id
      ORDER BY total DESC, last_at DESC
      LIMIT $${params.length}`,
    ...params,
  );
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.user_id);
  const [people, recent] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, name: true } }),
    prisma.rateEvent.groupBy({
      by: ["key"],
      where: { bucket: opts.window.bucket, key: { in: ids }, createdAt: { gt: new Date(Date.now() - opts.window.windowMs) } },
      _count: { _all: true },
    }),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  const recentBy = new Map(recent.map((r) => [r.key, r._count._all]));
  return rows.map((r) => ({
    userId: r.user_id,
    email: byId.get(r.user_id)?.email ?? null,
    name: byId.get(r.user_id)?.name ?? null,
    total: num(r.total),
    offTopic: num(r.off_topic),
    abuse: num(r.abuse),
    prefilter: num(r.prefilter),
    lastAt: r.last_at ? new Date(r.last_at).getTime() : null,
    recentWindow: recentBy.get(r.user_id) ?? 0,
  }));
}

