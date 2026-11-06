import { requireApiUser } from "@/lib/auth/session";
import { parseStreamCursor } from "@/lib/domain/notifications";
import { createNotificationStream, STREAM_DEFAULTS } from "@/lib/notifications/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 연결 하나는 STREAM_DEFAULTS.lifetimeMs(280초) 뒤 스스로 닫고, EventSource가 Last-Event-ID로 다시 연결한다.
export const maxDuration = 300;

/**
 * 새 알림 SSE(text/event-stream). **기본 꺼짐(404)** — 알림은 실시간으로 보내지 않고, 사용자가 새로고침하거나 알림 패널을 열 때
 * GET /api/notifications로 받는다(Vercel Hobby에서 연결 하나가 함수 시간을 계속 쓰지 않게). NOTIFICATIONS_SSE=1일 때만 연다.
 * 클라이언트(상단 알림 버튼)는 이 경로를 열지 않는다 — 다시 쓰려면 클라이언트 연결도 함께 되살려야 한다.
 * 커서는 Last-Event-ID 헤더(자동 재연결) 또는 ?since=<ms>. 다른 사이트에서 연 요청(Sec-Fetch-Site: cross-site)은 403.
 */
export async function GET(req: Request) {
  // 요청마다 읽는다(배포 환경 변수·테스트가 바로 반영된다).
  if (process.env.NOTIFICATIONS_SSE !== "1") return Response.json({ error: "찾을 수 없습니다." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 });
  }
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cursor = parseStreamCursor(req.headers.get("last-event-id")) ?? parseStreamCursor(new URL(req.url).searchParams.get("since"));
  const stream = createNotificationStream(user.id, { cursor, signal: req.signal, lifetimeMs: Math.min(STREAM_DEFAULTS.lifetimeMs, (maxDuration - 20) * 1000) });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
