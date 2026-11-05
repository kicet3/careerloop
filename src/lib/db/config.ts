// 순수 모듈(server-only·경로 별칭 없음): prisma.config.ts(Prisma CLI)도 이 파일을 불러온다.
import { databaseEnv, databaseHost, isLocalDatabaseHost, isPostgresUrl } from "../config/env-rules";

type Env = Record<string, string | undefined>;

export class DatabaseSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSetupError";
  }
}

/**
 * 실제로 접속할 DB 주소. url은 런타임(앱, 풀러 주소 — Supabase Transaction pooler 6543), directUrl은 마이그레이션용
 * (DIRECT_URL → POSTGRES_URL_NON_POOLING → url). 규칙은 env-rules.ts databaseEnv, scripts/migrate.mjs도 같은 규칙을 따른다.
 * 주소가 없거나 postgres(ql):// 가 아니면 DatabaseSetupError.
 */
export function resolveDatabase(env: Env = process.env): { url: string; directUrl: string } {
  const { url, directUrl } = databaseEnv(env);
  if (!url) {
    throw new DatabaseSetupError(
      "DATABASE_URL이 없습니다. 로컬은 `docker compose -p resume-career up -d postgres` 후 " +
        "DATABASE_URL=postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:54329/careerloop, 배포는 Supabase Transaction pooler 주소를 넣으세요.",
    );
  }
  for (const [name, value] of [["DATABASE_URL", url], ["DIRECT_URL", directUrl]] as const) {
    if (value && !isPostgresUrl(value)) {
      throw new DatabaseSetupError(`${name}는 postgres:// 또는 postgresql:// 주소여야 합니다(SQLite file:·Turso libsql: 주소는 더 이상 쓰지 않습니다).`);
    }
  }
  return { url, directUrl: directUrl ?? url };
}

export interface PgConnectionConfig {
  connectionString: string;
  /** false면 평문(로컬). 객체면 TLS. */
  ssl: false | { rejectUnauthorized: boolean };
  /** 주소의 ?schema=(Prisma 관례). PrismaPg 옵션으로 넘긴다. 없으면 undefined(public). */
  schema?: string;
}

/**
 * pg(node-postgres) 접속 설정. 주소의 sslmode를 따르되 localhost가 아닌 호스트는 TLS를 강제한다.
 * - sslmode=verify-full/verify-ca: 주소 그대로 pg에 맡긴다(인증서 검증, sslrootcert 등).
 * - sslmode=disable: 평문(명시했을 때만).
 * - 그 밖(require/prefer/allow/없음): libpq의 require와 같게 암호화만 하고 인증서 체인은 검증하지 않는다
 *   (Supabase 풀러 인증서는 Supabase 자체 CA라 기본 CA 목록으로는 검증되지 않는다). pg 8은 sslmode=require를
 *   verify-full로 해석하므로 주소에서 sslmode를 빼고 ssl 옵션으로 넘긴다.
 * - localhost(127.x, ::1): sslmode가 없으면 평문.
 */
export function pgConnectionConfig(url: string): PgConnectionConfig {
  const host = databaseHost(url);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { connectionString: url, ssl: isLocalDatabaseHost(host) ? false : { rejectUnauthorized: false } };
  }
  const mode = parsed.searchParams.get("sslmode")?.toLowerCase() ?? null;
  const schema = parsed.searchParams.get("schema") || undefined;
  if (mode === "verify-full" || mode === "verify-ca") {
    return { connectionString: url, ssl: { rejectUnauthorized: true }, schema };
  }
  for (const k of ["sslmode", "uselibpqcompat", "pgbouncer", "connection_limit", "pool_timeout", "connect_timeout", "schema"]) {
    parsed.searchParams.delete(k);
  }
  const connectionString = parsed.toString();
  if (mode === "disable") return { connectionString, ssl: false, schema };
  if (!mode && isLocalDatabaseHost(host)) return { connectionString, ssl: false, schema };
  return { connectionString, ssl: { rejectUnauthorized: false }, schema };
}

/** 로그에 남겨도 되는 주소 표시(호스트:포트/DB, 비밀번호 없음). */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(해석할 수 없는 주소)";
  }
}
