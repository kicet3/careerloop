import "server-only";
/**
 * 알림 폴링(GET /api/notifications) 때 그 사용자의 끊긴 백그라운드 작업을 정리하고 결과를 알림으로 남긴다.
 * after()가 플랫폼 시간 초과·서버 재시작으로 catch까지 가지 못하면 작업이 '진행 중'으로 남는데, 진행 화면·목록을 다시 열지 않으면
 * 아무도 닫지 않는다 — 화면을 떠나도 알림으로 결과를 알 수 있게 여기서 닫는다.
 * 던지지 않는다(정리가 실패해도 알림 목록은 돌려준다).
 */
import { markStaleRunsFailed, notifyIdleDeadlineStops } from "@/lib/diagnoses/service";
import { sweepStaleDraftJobs } from "@/lib/resumes/draft-jobs";

export async function sweepStaleJobs(userId: string, now: number = Date.now()): Promise<void> {
  const results = await Promise.allSettled([
    sweepStaleDraftJobs(userId, now),
    markStaleRunsFailed(userId).then(() => notifyIdleDeadlineStops(userId, now)),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[notifications] 멈춘 작업 정리 실패", (r.reason as Error)?.message?.slice(0, 200));
  }
}
