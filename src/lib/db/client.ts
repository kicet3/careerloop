import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * 로컬: DATABASE_URL 미설정 시 ./data/app.db(SQLite 파일).
 * 배포: Turso 등 libsql URL + DATABASE_AUTH_TOKEN.
 */
function createDb() {
  const url = process.env.DATABASE_URL ?? "file:./data/app.db";
  const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
  return drizzle(client, { schema });
}

type Db = ReturnType<typeof createDb>;

// 개발 서버 HMR에서 연결이 계속 늘어나지 않도록 전역에 보관한다.
const globalForDb = globalThis as unknown as { __db?: Db };
export const db: Db = globalForDb.__db ?? (globalForDb.__db = createDb());
export { schema };
