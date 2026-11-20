export async function register() {
  // 서버 전용 설정 검사는 Node 런타임에서만 실행한다.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 배포 모드 검사. PRODUCTION 필수 설정이 빠졌으면 누락 목록을 출력하고 프로세스를 끝낸다.
  // DB 마이그레이션은 런타임에 적용하지 않는다 — 배포 빌드(scripts/migrate.mjs)나 `npm run db:migrate`가 적용한다.
  const { checkEnvOnStartup } = await import("./lib/config/startup");
  checkEnvOnStartup();

  // 에이전트 실행기(맥미니, RESUME_AGENT_RUNNER=1): 놓친 에이전트 작업을 주기적으로 주워 실행한다(deploy/agent/README.md).
  if (process.env.RESUME_AGENT_RUNNER?.trim() === "1" && !process.env.VERCEL) {
    const { startAgentRunnerLoop } = await import("./lib/resume-agent/runner-loop");
    startAgentRunnerLoop();
  }
}
