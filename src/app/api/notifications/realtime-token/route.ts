import { requireApiUser } from "@/lib/auth/session";
import { createRateLimiter } from "@/lib/auth/rate-limit";
import { notificationTopic, type NotificationRealtimeToken } from "@/lib/domain/notifications-realtime";
import { realtimeConfig, signRealtimeToken } from "@/lib/notifications/realtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
// 탭 하나는 1시간에 한두 번 받는다. 새로고침이 잦아도 넉넉하고, 남용은 막는 정도(인스턴스별 메모리 기준).
const tokenLimiter = createRateLimiter({ limit: 30, windowMs: 10 * 60_000 });

/**
 * 알림 실시간 수신용 Supabase Realtime 토큰(로그인한 내 채널 notifications:<내 id>만 — RLS가 막는다). docs/REALTIME.md.
 * 설정(환경 변수)이 없으면 404 — 클라이언트는 실시간 없이 새로고침·패널 열기 때만 받는다.
 * 응답에는 공개 키(anon/publishable)와 짧은 수명의 토큰만 싣는다(서비스 키·서명 키는 서버 밖으로 나가지 않는다).
 */
export async function GET(req: Request) {
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403, headers: NO_STORE });
  }
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cfg = realtimeConfig();
  if (!cfg) return Response.json({ error: "실시간 알림이 설정되지 않았습니다.", configured: false }, { status: 404, headers: NO_STORE });
  const limited = tokenLimiter.hit(user.id);
  if (!limited.ok) {
    return Response.json(
      { error: "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSec) } },
    );
  }
  const { token, expiresAt } = signRealtimeToken(user.id, cfg.signer);
  const body: NotificationRealtimeToken = { url: cfg.url, anonKey: cfg.anonKey, token, topic: notificationTopic(user.id), expiresAt };
  return Response.json(body, { headers: NO_STORE });
}
