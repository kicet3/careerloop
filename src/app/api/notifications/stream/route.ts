import { requireApiUser } from "@/lib/auth/session";
import { parseStreamCursor } from "@/lib/domain/notifications";
import { createNotificationStream, STREAM_DEFAULTS } from "@/lib/notifications/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 연결 하나는 STREAM_DEFAULTS.lifetimeMs(280초) 뒤 스스로 닫고, EventSource가 Last-Event-ID로 다시 연결한다.
export const maxDuration = 300;

/**
 * 새 알림 SSE(text/event-stream). 상단 알림 버튼이 탭이 보이는 동안 연다. 목록·읽음은 GET /api/notifications·POST /read(DB가 기준).
 * 커서는 Last-Event-ID 헤더(자동 재연결) 또는 ?since=<ms>. 다른 사이트에서 연 요청(Sec-Fetch-Site: cross-site)은 403.
 */
export async function GET(req: Request) {
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
