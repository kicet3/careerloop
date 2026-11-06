import { requireAdminApiUser } from "@/lib/auth/session";
import { isUsagePeriod, periodStart, type UsagePeriod } from "@/lib/domain/llm-usage";
import { getUserUsage, listUsageByTask, listUsageByUser } from "@/lib/llm/usage-report";

/**
 * 토큰 사용량(관리자). ?period=today|7d|30d|all(기본 30d)&userId=(선택).
 * userId 없음 → { period, users, totals, byTask } · 있음 → { period, user, totals, byTask, byDay, byModel }(없는 회원 404).
 * 비용은 costMicroUsd(USD 백만분의 1, 추정).
 */
export async function GET(req: Request) {
  const admin = await requireAdminApiUser();
  if (admin instanceof Response) return admin;
  const sp = new URL(req.url).searchParams;
  const p = sp.get("period");
  const period: UsagePeriod = isUsagePeriod(p) ? p : "30d";
  const since = periodStart(period);
  const headers = { "Cache-Control": "no-store" };
  const userId = sp.get("userId");
  if (userId) {
    const usage = await getUserUsage(userId, { since });
    if (!usage) return Response.json({ error: "회원을 찾을 수 없습니다." }, { status: 404, headers });
    return Response.json({ period, ...usage }, { headers });
  }
  const [list, byTask] = await Promise.all([listUsageByUser({ since }), listUsageByTask({ since })]);
  return Response.json({ period, ...list, byTask }, { headers });
}
