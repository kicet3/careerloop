import { databaseEnv } from "@/lib/config/env-rules";

/** 로컬 SQLite 기본 파일(DATABASE_URL·TURSO_DATABASE_URL이 모두 없을 때). */
export const DEFAULT_DATABASE_URL = "file:./data/app.db";

/**
 * 실제로 접속할 DB 주소·토큰. DATABASE_URL·DATABASE_AUTH_TOKEN이 우선이고, 없으면 Vercel Turso 연동이 넣는
 * TURSO_DATABASE_URL·TURSO_AUTH_TOKEN, 그것도 없으면 로컬 파일. (scripts/migrate.mjs도 같은 규칙을 따른다.)
 */
export function resolveDatabase(env: Record<string, string | undefined> = process.env): { url: string; authToken: string | undefined } {
  const { url, authToken } = databaseEnv(env);
  return { url: url ?? DEFAULT_DATABASE_URL, authToken };
}
