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

