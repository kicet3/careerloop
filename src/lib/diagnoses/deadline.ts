/**
 * 백그라운드 실행(after())의 시간 예산. 플랫폼이 함수를 maxDuration에 강제 종료하기 전에 runner가 스스로 멈추고
 * '실패(재시도 가능)'로 기록하도록, 요청 시작 시각 기준 마감 시각을 계산한다.
 *
 * - Vercel이면 라우트의 maxDuration에서 30초 여유를 뺀 값. DIAGNOSIS_TIME_BUDGET_SEC가 양수면 그 값과 둘 중 작은 쪽
 *   (예산을 maxDuration보다 크게 잡아도 플랫폼이 강제로 끊기 전에 멈추게).
 * - 그 밖(자체 호스팅 Node)에는 DIAGNOSIS_TIME_BUDGET_SEC가 양수면 그 값, 없으면 플랫폼 시간 제한이 없으므로 마감을 두지 않는다(undefined).
 */
export function runDeadline(
  startedAt: number,
  maxDurationSec: number,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = Number(env.DIAGNOSIS_TIME_BUDGET_SEC);
  const budget = Number.isFinite(raw) && raw > 0 ? raw : null;
  if (env.VERCEL) {
    const platform = Math.max(30, maxDurationSec - 30);
    return startedAt + Math.min(budget ?? platform, platform) * 1000;
  }
  return budget === null ? undefined : startedAt + budget * 1000;
}
