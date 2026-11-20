import "server-only";
/**
 * 에이전트 실행기(맥미니의 next start, RESUME_AGENT_RUNNER=1)의 주기 점검. instrumentation.ts가 서버 시작 때 한 번 켠다.
 * 10초마다 sweepRunnerJobs로 이어 줄 호출이 없는 작업을 찾아 이 프로세스에서 실행한다 — Vercel의 서명 호출이 닿지 않았어도,
 * 실행기를 재시작해 실행 중이던 작업의 리스가 만료됐어도 화면 없이 이어진다. Vercel 배포에서는 켜지 않는다(함수는 주기 작업을 유지하지 못한다).
 */
import { sweepRunnerJobs } from "./jobs";

export const RUNNER_SWEEP_INTERVAL_MS = 10_000;

const g = globalThis as unknown as { __agentRunnerLoop?: ReturnType<typeof setInterval> };

export function startAgentRunnerLoop(): void {
  if (g.__agentRunnerLoop) return;
  let sweeping = false;
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const started = await sweepRunnerJobs();
      if (started > 0) console.log(`[agent-runner] 작업 ${started}개를 이어서 실행합니다.`);
    } catch (err) {
      console.error("[agent-runner] 주기 점검 실패:", err instanceof Error ? err.message : err);
    } finally {
      sweeping = false;
    }
  };
  g.__agentRunnerLoop = setInterval(() => void tick(), RUNNER_SWEEP_INTERVAL_MS);
  g.__agentRunnerLoop.unref?.();
  console.log("[agent-runner] 에이전트 실행기 주기 점검을 시작했습니다.");
}
