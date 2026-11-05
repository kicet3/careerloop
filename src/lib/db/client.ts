import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { resolveDatabase } from "./config";
import * as schema from "./schema";

/**
 * 로컬: DATABASE_URL 미설정 시 ./data/app.db(SQLite 파일).
 * 배포: Turso 등 libsql URL + DATABASE_AUTH_TOKEN(없으면 Vercel Turso 연동의 TURSO_DATABASE_URL·TURSO_AUTH_TOKEN).
 */
function createDb() {
  const { url, authToken } = resolveDatabase();
  const client = createClient({ url, authToken });
  return drizzle(client, { schema });
}

type Db = ReturnType<typeof createDb>;

// 개발 서버 HMR에서 연결이 계속 늘어나지 않도록 전역에 보관한다.
const globalForDb = globalThis as unknown as { __db?: Db };
export const db: Db = globalForDb.__db ?? (globalForDb.__db = createDb());
export { schema };
