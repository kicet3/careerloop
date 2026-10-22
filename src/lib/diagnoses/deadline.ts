/**
 * 백그라운드 실행(after())의 시간 예산. 플랫폼이 함수를 maxDuration에 강제 종료하기 전에 runner가 스스로 멈추고
 * '실패(재시도 가능)'로 기록하도록, 요청 시작 시각 기준 마감 시각을 계산한다.
 *
 * - DIAGNOSIS_TIME_BUDGET_SEC가 양수면 그 값(초)을 쓴다.
 * - 없고 Vercel이면 라우트의 maxDuration에서 30초 여유를 뺀다.
 * - 그 밖(자체 호스팅 Node)에는 플랫폼 시간 제한이 없으므로 마감을 두지 않는다(undefined).
 */
export function runDeadline(
  startedAt: number,
  maxDurationSec: number,
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const budget = Number(env.DIAGNOSIS_TIME_BUDGET_SEC);
  if (Number.isFinite(budget) && budget > 0) return startedAt + budget * 1000;
  if (env.VERCEL) return startedAt + Math.max(30, maxDurationSec - 30) * 1000;
  return undefined;
}
