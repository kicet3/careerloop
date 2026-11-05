/**
 * 배포 모드(APP_ENV) 규칙. 순수 함수만 둔다(server-only를 넣지 않는다 — next.config.ts가 빌드 때 같은 검사를 쓴다).
 * 앱 코드는 서버 전용 래퍼인 ./env에서 불러온다.
 *
 * - DEV(기본): 빠진 설정이 있어도 뜬다. 로컬 저장소 폴백·CLI 엔진·Host 기반 Origin 검사를 허용한다.
 * - PRODUCTION: 필수 설정이 모두 있어야 뜬다(validateProductionEnv). 세션 쿠키 Secure 강제, 저장소는 R2만,
 *   CLI 엔진은 CLI_PROVIDERS_IN_PRODUCTION=1일 때만(Vercel에서는 항상 꺼짐), same-origin 검사는 앱 주소(appUrl) 호스트만 믿는다.
 *   Google 로그인(GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET) 필수(가입은 Google로만, 로그인은 Google·이메일).
 *
 * Vercel(VERCEL 환경 변수가 있음):
 * - APP_ENV를 비운 Production 배포(VERCEL_ENV=production)는 PRODUCTION으로 본다(실수로 DEV 규칙으로 뜨지 않게).
 * - APP_URL을 비우면 Production은 https://${VERCEL_PROJECT_PRODUCTION_URL}, Preview는 https://${VERCEL_BRANCH_URL ?? VERCEL_URL}.
 * - 로컬 SQLite(file:) DB와 CLI 엔진은 쓸 수 없다(배포 폴더가 읽기 전용이고 claude·codex 실행 파일이 없다).
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

const has = (env: Env, key: string) => Boolean(env[key]?.trim());

/** Vercel에서 실행(빌드) 중인가. */
export function onVercel(env: Env = process.env): boolean {
  return has(env, "VERCEL");
}

/**
 * 현재 배포 모드. DEV·PRODUCTION 밖의 값이면 AppEnvError.
 * 비어 있으면 DEV — 단 Vercel Production 배포(VERCEL_ENV=production)는 PRODUCTION.
 */
export function appEnv(env: Env = process.env): AppEnv {
  const raw = env.APP_ENV?.trim();
  if (!raw) return onVercel(env) && env.VERCEL_ENV === "production" ? "PRODUCTION" : "DEV";
  if ((APP_ENVS as readonly string[]).includes(raw)) return raw as AppEnv;
  throw new AppEnvError(`APP_ENV 값이 잘못되었습니다: "${raw}". DEV 또는 PRODUCTION만 쓸 수 있습니다.`);
}

export function isProduction(env: Env = process.env): boolean {
  return appEnv(env) === "PRODUCTION";
}

export const R2_ENV_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
const NEO4J_ENV_KEYS = ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"] as const;

/** 스킴 없는 호스트(Vercel 시스템 변수 형식)를 https URL로. */
function httpsFromHost(raw: string | undefined): string | null {
  const h = raw?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return h ? `https://${h}` : null;
}

/**
 * 앱의 공개 주소. APP_URL이 있으면 그 값. 없으면 Vercel 시스템 변수로 정한다:
 * Production → https://${VERCEL_PROJECT_PRODUCTION_URL}(가장 짧은 운영 도메인), Preview → https://${VERCEL_BRANCH_URL ?? VERCEL_URL}.
 * 정하지 못하면 null.
 */
export function appUrl(env: Env = process.env): string | null {
  const raw = env.APP_URL?.trim();
  if (raw) return raw;
  if (!onVercel(env)) return null;
  if (env.VERCEL_ENV === "production") return httpsFromHost(env.VERCEL_PROJECT_PRODUCTION_URL);
  if (env.VERCEL_ENV === "preview") return httpsFromHost(env.VERCEL_BRANCH_URL) ?? httpsFromHost(env.VERCEL_URL);
  return null;
}

/** 앱 주소(appUrl)가 https URL이면 그 호스트(host:port), 아니면 null. */
export function httpsAppUrlHost(env: Env = process.env): string | null {
  const raw = appUrl(env);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.host ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * PRODUCTION same-origin 검사가 믿는 호스트. 앱 주소 호스트, 그리고 Vercel Preview 배포면 그 배포의 주소
 * (VERCEL_URL·VERCEL_BRANCH_URL — 플랫폼이 넣는 값이라 요청 헤더와 달리 바꿀 수 없다).
 */
export function trustedOriginHosts(env: Env = process.env): string[] {
  const hosts = new Set<string>();
  const app = httpsAppUrlHost(env);
  if (app) hosts.add(app);
  if (onVercel(env) && env.VERCEL_ENV === "preview") {
    for (const k of ["VERCEL_URL", "VERCEL_BRANCH_URL"]) {
      const u = httpsFromHost(env[k]);
      if (u) hosts.add(new URL(u).host);
    }
  }
  return [...hosts];
}

export const GOOGLE_ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

/** Google 로그인(OAuth 클라이언트 ID·비밀) 설정이 모두 있는가. */
export function googleLoginConfigured(env: Env = process.env): boolean {
  return GOOGLE_ENV_KEYS.every((k) => has(env, k));
}

/** DB 주소·토큰. DATABASE_*가 우선이고, 없으면 Vercel Turso 연동이 넣는 TURSO_DATABASE_URL·TURSO_AUTH_TOKEN. */
export function databaseEnv(env: Env = process.env): { url: string | null; authToken: string | undefined } {
  const url = env.DATABASE_URL?.trim() || env.TURSO_DATABASE_URL?.trim() || null;
  const authToken = env.DATABASE_AUTH_TOKEN?.trim() || env.TURSO_AUTH_TOKEN?.trim() || undefined;
  return { url, authToken };
}

/** DB 설정의 문제(없으면 null). Vercel에서는 로컬 파일 DB를 막고, Turso 주소에는 토큰을 요구한다. */
export function databaseEnvProblem(env: Env = process.env): string | null {
  const { url, authToken } = databaseEnv(env);
  if (!url) return "DATABASE_URL";
  if (url.startsWith("file:") && onVercel(env)) return "DATABASE_URL(Vercel에서는 file: 로컬 DB를 쓸 수 없음 — libsql://… Turso 주소)";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (host.endsWith(".turso.io") && !authToken) return "DATABASE_AUTH_TOKEN(Turso DB 토큰)";
  return null;
}

/** CLI 엔진(claude·codex)을 이 환경에서 켤 수 있는가. Vercel 같은 서버리스에는 실행 파일·쓰기 가능한 홈이 없다. */
export function cliProvidersAllowed(env: Env = process.env): boolean {
  if (env.CLI_PROVIDERS !== "1" || onVercel(env)) return false;
  return !isProduction(env) || env.CLI_PROVIDERS_IN_PRODUCTION === "1";
}

/** PRODUCTION에서 쓸 수 있는 AI 엔진이 하나라도 설정됐는가. CLI는 cliProvidersAllowed와 같은 규칙. */
function hasProductionEngine(env: Env): boolean {
  return has(env, "ANTHROPIC_API_KEY") || cliProvidersAllowed({ ...env, APP_ENV: "PRODUCTION" });
}

/** PRODUCTION 필수 설정 중 빠지거나 잘못된 항목 이름(설명 포함). 모드와 무관하게 검사만 한다. */
export function missingProductionEnv(env: Env = process.env): string[] {
  const missing: string[] = [];
  if (!appUrl(env)) missing.push("APP_URL");
  else if (!httpsAppUrlHost(env)) missing.push("APP_URL(https:// 주소여야 함)");
  const db = databaseEnvProblem(env);
  if (db) missing.push(db);
  for (const k of NEO4J_ENV_KEYS) if (!has(env, k)) missing.push(k);
  for (const k of R2_ENV_KEYS) if (!has(env, k)) missing.push(k);
  if (!hasProductionEngine(env)) {
    missing.push(
      onVercel(env)
        ? "AI 엔진(ANTHROPIC_API_KEY — Vercel에서는 CLI 엔진을 쓸 수 없음)"
        : "AI 엔진(ANTHROPIC_API_KEY 또는 CLI_PROVIDERS=1 + CLI_PROVIDERS_IN_PRODUCTION=1)",
    );
  }
  for (const k of GOOGLE_ENV_KEYS) if (!has(env, k)) missing.push(k);
  return missing;
}

/** 모드와 무관하게 알려 줄 Vercel 안내. */
function vercelWarnings(env: Env): string[] {
  if (!onVercel(env)) return [];
  const warnings: string[] = [];
  if (env.CLI_PROVIDERS === "1") {
    warnings.push("Vercel에서는 CLI 엔진을 쓸 수 없어 CLI_PROVIDERS=1을 무시합니다. ANTHROPIC_API_KEY(Claude API)를 쓰세요.");
  }
  return warnings;
}

/** DEV에서 알려 줄 안내(기능이 꺼지거나 개발용 대체 동작을 쓰는 설정). */
function devWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (onVercel(env)) {
    warnings.push("Vercel에서 APP_ENV=DEV로 떠 있습니다. 배포에는 APP_ENV=PRODUCTION과 필수 설정(README '배포')을 넣어 주세요.");
    const db = databaseEnvProblem(env);
    if (db) warnings.push(`DB 설정이 Vercel에서 동작하지 않습니다: ${db}. Turso(libsql://…)와 DATABASE_AUTH_TOKEN을 넣어 주세요.`);
  }
  if (R2_ENV_KEYS.some((k) => !has(env, k))) {
    warnings.push("R2 설정이 없어 이력서 본문을 로컬 폴더(STORAGE_DIR, 기본 ./data/storage)에 저장합니다.");
  }
  if (!has(env, "NEO4J_URI")) warnings.push("NEO4J_URI가 없어 경력 그래프 기능이 꺼집니다.");
  else if (!has(env, "NEO4J_PASSWORD")) warnings.push("NEO4J_URI는 있는데 NEO4J_PASSWORD가 비어 있어 그래프 저장소에 연결하지 못할 수 있습니다.");
  if (!has(env, "ANTHROPIC_API_KEY") && !cliProvidersAllowed(env)) {
    warnings.push("ANTHROPIC_API_KEY·CLI_PROVIDERS가 모두 없어 쓸 수 있는 AI 엔진이 없습니다.");
  }
  if (!googleLoginConfigured(env)) {
    warnings.push("GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET이 없어 Google 로그인·회원가입이 꺼집니다(비밀번호를 설정한 기존 계정만 이메일로 로그인 가능).");
  }
  return warnings;
}

/**
 * 서버 시작(과 Vercel 빌드) 시 검사. APP_ENV가 잘못됐거나 PRODUCTION인데 필수 설정이 빠졌으면 빠진 항목을 모두 담아
 * AppEnvError를 던진다. 던지지 않으면 안내 문구 목록을 돌려준다(호출자가 한 번 출력).
 */
export function validateProductionEnv(env: Env = process.env): { env: AppEnv; warnings: string[] } {
  const mode = appEnv(env);
  if (mode === "DEV") return { env: mode, warnings: [...devWarnings(env), ...vercelWarnings(env)] };
  const missing = missingProductionEnv(env);
  if (missing.length > 0) {
    throw new AppEnvError(`APP_ENV=PRODUCTION 필수 설정이 빠졌습니다: ${missing.join(", ")}`);
  }
  return { env: mode, warnings: vercelWarnings(env) };
}
