export async function register() {
  // 서버 전용 설정 검사는 Node 런타임에서만 실행한다.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 배포 모드 검사. PRODUCTION 필수 설정이 빠졌으면 누락 목록을 출력하고 프로세스를 끝낸다.
  // DB 마이그레이션은 런타임에 적용하지 않는다 — 배포 빌드(scripts/migrate.mjs)나 `npm run db:migrate`가 적용한다.
  const { checkEnvOnStartup } = await import("./lib/config/startup");
  checkEnvOnStartup();
}
