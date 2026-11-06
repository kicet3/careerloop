import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { listNotifications } from "@/lib/notifications/service";
import { sweepStaleJobs } from "@/lib/notifications/sweep";

export const runtime = "nodejs";

/**
 * 내 최근 알림 + 읽지 않은 수. ?since=<ms>면 그 뒤에 만든 알림만. 상단 알림 버튼이 앱 틀을 불러올 때 한 번, 패널을 열 때 부른다(주기 폴링 없음).
 * 먼저 끊긴 백그라운드 작업(초안·진단)을 닫아, 그 실패 알림이 이번 응답에 함께 실린다.
 */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const raw = new URL(req.url).searchParams.get("since");
    const since = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
    await sweepStaleJobs(user.id);
    return Response.json(await listNotifications(user.id, { since }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/notifications");
  }
}
