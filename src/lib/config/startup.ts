import "server-only";
import { validateProductionEnv } from "./env";

/**
 * 서버 시작 시 배포 모드 검사(instrumentation register()에서 마이그레이션 전에 호출, Node 런타임 전용).
 * APP_ENV가 잘못됐거나 PRODUCTION 필수 설정이 빠졌으면 누락 목록을 출력하고 프로세스를 끝낸다 —
 * register()가 던지기만 하면 Next는 포트를 연 채 모든 요청에 500을 돌려주므로, 반쯤 뜬 서버가 남지 않게 직접 종료한다.
 * DEV면 안내(로컬 저장소 사용 등)를 console.warn 한 번 출력한다.
 * Vercel에서는 같은 검사를 빌드 때(next.config.ts) 먼저 해서 빠진 설정이 있으면 배포 자체가 실패한다 — 여기서 끝나는 경우는
 * 빌드 뒤에 환경 변수를 바꾼 때뿐이며, 누락 목록은 Runtime Logs에 남는다.
 */
export function checkEnvOnStartup(): void {
  let result: ReturnType<typeof validateProductionEnv>;
  try {
    result = validateProductionEnv();
  } catch (err) {
    console.error(`[env] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (result.warnings.length > 0) console.warn(`[env] APP_ENV=${result.env}\n- ${result.warnings.join("\n- ")}`);
}
