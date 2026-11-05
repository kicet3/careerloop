import "server-only";
/**
 * 배포 모드(APP_ENV). 서버 전용.
 *
 * - DEV(기본): 빠진 설정이 있어도 뜬다. 로컬 저장소 폴백·CLI 엔진·Host 기반 Origin 검사를 허용한다.
 * - PRODUCTION: 필수 설정이 모두 있어야 뜬다(validateProductionEnv). 세션 쿠키 Secure 강제, 저장소는 R2만,
 *   CLI 엔진은 CLI_PROVIDERS_IN_PRODUCTION=1일 때만, same-origin 검사는 APP_URL 호스트만 믿는다.
 *   Google 로그인(GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET) 필수(가입은 Google로만, 로그인은 Google·이메일).
 *
 * NODE_ENV(빌드 종류)와는 별개다 — `next start`라도 APP_ENV를 주지 않으면 DEV다.
 * 모든 함수는 테스트를 위해 env를 인자로 받는다(기본 process.env).
 */

export const APP_ENVS = ["DEV", "PRODUCTION"] as const;
export type AppEnv = (typeof APP_ENVS)[number];

type Env = Record<string, string | undefined>;

export class AppEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppEnvError";
  }
}

/** 현재 배포 모드. 비어 있으면 DEV, DEV·PRODUCTION 밖의 값이면 AppEnvError. */
export function appEnv(env: Env = process.env): AppEnv {
  const raw = env.APP_ENV?.trim();
  if (!raw) return "DEV";
  if ((APP_ENVS as readonly string[]).includes(raw)) return raw as AppEnv;
  throw new AppEnvError(`APP_ENV 값이 잘못되었습니다: "${raw}". DEV 또는 PRODUCTION만 쓸 수 있습니다.`);
}

export function isProduction(env: Env = process.env): boolean {
  return appEnv(env) === "PRODUCTION";
}

const has = (env: Env, key: string) => Boolean(env[key]?.trim());

export const R2_ENV_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const NEO4J_ENV_KEYS = ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"] as const;

/** APP_URL이 https URL이면 그 호스트(host:port), 아니면 null. */
export function httpsAppUrlHost(env: Env = process.env): string | null {
  const raw = env.APP_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.host ? url.host : null;
  } catch {
    return null;
  }
}

export const GOOGLE_ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

/** Google 로그인(OAuth 클라이언트 ID·비밀) 설정이 모두 있는가. */
export function googleLoginConfigured(env: Env = process.env): boolean {
  return GOOGLE_ENV_KEYS.every((k) => has(env, k));
}

/** PRODUCTION에서 쓸 수 있는 AI 엔진이 하나라도 설정됐는가. CLI는 CLI_PROVIDERS_IN_PRODUCTION=1까지 있어야 켜진다(cliProvidersEnabled와 같은 규칙). */
function hasProductionEngine(env: Env): boolean {
  return has(env, "ANTHROPIC_API_KEY") || (env.CLI_PROVIDERS === "1" && env.CLI_PROVIDERS_IN_PRODUCTION === "1");
}

/** PRODUCTION 필수 설정 중 빠지거나 잘못된 항목 이름(설명 포함). 모드와 무관하게 검사만 한다. */
export function missingProductionEnv(env: Env = process.env): string[] {
  const missing: string[] = [];
  if (!has(env, "APP_URL")) missing.push("APP_URL");
  else if (!httpsAppUrlHost(env)) missing.push("APP_URL(https:// 주소여야 함)");
  if (!has(env, "DATABASE_URL")) missing.push("DATABASE_URL");
  for (const k of NEO4J_ENV_KEYS) if (!has(env, k)) missing.push(k);
  for (const k of R2_ENV_KEYS) if (!has(env, k)) missing.push(k);
  if (!hasProductionEngine(env)) {
    missing.push("AI 엔진(ANTHROPIC_API_KEY 또는 CLI_PROVIDERS=1 + CLI_PROVIDERS_IN_PRODUCTION=1)");
  }
  for (const k of GOOGLE_ENV_KEYS) if (!has(env, k)) missing.push(k);
  return missing;
}

/** DEV에서 알려 줄 안내(기능이 꺼지거나 개발용 대체 동작을 쓰는 설정). */
function devWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (has(env, "VERCEL")) {
    warnings.push("Vercel에서 APP_ENV=DEV로 떠 있습니다. 배포에는 APP_ENV=PRODUCTION과 필수 설정(README '배포')을 넣어 주세요.");
  }
  if (R2_ENV_KEYS.some((k) => !has(env, k))) {
    warnings.push("R2 설정이 없어 이력서 본문을 로컬 폴더(STORAGE_DIR, 기본 ./data/storage)에 저장합니다.");
  }
  if (!has(env, "NEO4J_URI")) warnings.push("NEO4J_URI가 없어 경력 그래프 기능이 꺼집니다.");
  else if (!has(env, "NEO4J_PASSWORD")) warnings.push("NEO4J_URI는 있는데 NEO4J_PASSWORD가 비어 있어 그래프 저장소에 연결하지 못할 수 있습니다.");
  if (!has(env, "ANTHROPIC_API_KEY") && env.CLI_PROVIDERS !== "1") {
    warnings.push("ANTHROPIC_API_KEY·CLI_PROVIDERS가 모두 없어 쓸 수 있는 AI 엔진이 없습니다.");
  }
  if (!googleLoginConfigured(env)) {
    warnings.push("GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET이 없어 Google 로그인·회원가입이 꺼집니다(비밀번호를 설정한 기존 계정만 이메일로 로그인 가능).");
  }
  return warnings;
}

/**
 * 서버 시작 시 검사. APP_ENV가 잘못됐거나 PRODUCTION인데 필수 설정이 빠졌으면 빠진 항목을 모두 담아 AppEnvError를 던진다.
 * DEV면 던지지 않고 안내 문구 목록을 돌려준다(호출자가 한 번 출력).
 */
export function validateProductionEnv(env: Env = process.env): { env: AppEnv; warnings: string[] } {
  const mode = appEnv(env);
  if (mode === "DEV") return { env: mode, warnings: devWarnings(env) };
  const missing = missingProductionEnv(env);
  if (missing.length > 0) {
    throw new AppEnvError(`APP_ENV=PRODUCTION 필수 설정이 빠졌습니다: ${missing.join(", ")}`);
  }
  return { env: mode, warnings: [] };
}
