#!/usr/bin/env node
/**
 * 배포용 DB 마이그레이션(drizzle/ 폴더)을 한 번 적용한다. Vercel 빌드(vercel.json buildCommand)가 `next build` 뒤에 부른다.
 * 런타임(src/lib/db/migrate.ts)은 Vercel에서 마이그레이션을 적용하지 않고 확인만 한다 — 인스턴스마다 동시에 적용하는 경쟁과
 * Preview 배포가 운영 DB를 먼저 바꾸는 일을 막기 위해서다.
 *
 * - Vercel Production 빌드(VERCEL_ENV=production): 적용한다.
 * - Vercel Preview·Development 빌드: MIGRATE_ON_BUILD=1일 때만 적용한다(Preview 전용 DB를 따로 둔 경우에만 켜세요).
 * - Vercel 밖(직접 실행, `npm run db:migrate:deploy`): 적용한다.
 *
 * DB 주소 규칙은 src/lib/db/config.ts와 같다: DATABASE_URL·DATABASE_AUTH_TOKEN, 없으면 TURSO_DATABASE_URL·TURSO_AUTH_TOKEN.
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const onVercel = Boolean(env.VERCEL?.trim());

if (onVercel && env.VERCEL_ENV !== "production" && env.MIGRATE_ON_BUILD !== "1") {
  console.log(`[migrate] VERCEL_ENV=${env.VERCEL_ENV ?? "?"}: 건너뜀(Preview 전용 DB면 MIGRATE_ON_BUILD=1).`);
  process.exit(0);
}

const url = env.DATABASE_URL?.trim() || env.TURSO_DATABASE_URL?.trim();
const authToken = env.DATABASE_AUTH_TOKEN?.trim() || env.TURSO_AUTH_TOKEN?.trim() || undefined;
if (!url) {
  console.error("[migrate] DATABASE_URL(또는 TURSO_DATABASE_URL)이 없습니다. 빌드 환경 변수에 Turso 주소와 토큰을 넣어 주세요.");
  process.exit(1);
}
if (onVercel && url.startsWith("file:")) {
  console.error("[migrate] Vercel에서는 file: 로컬 DB를 쓸 수 없습니다. DATABASE_URL=libsql://…(Turso)를 넣어 주세요.");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = createClient({ url, authToken });
try {
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  console.log(`[migrate] 적용 완료: ${new URL(url).host || url}`);
} catch (err) {
  console.error("[migrate] 마이그레이션 실패:", err);
  process.exitCode = 1;
} finally {
  client.close();
}
