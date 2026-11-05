import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";
import { databaseEnv } from "./src/lib/config/env-rules";

/**
 * Prisma CLI 설정(generate·migrate). 앱 런타임 접속은 src/lib/db/client.ts(PrismaPg 어댑터)가 따로 정한다.
 * Prisma 7 CLI는 .env를 읽지 않으므로 로컬 개발 편의로 .env.local·.env를 불러온다(이미 있는 환경 변수는 덮어쓰지 않는다).
 * 마이그레이션 주소: DIRECT_URL → POSTGRES_URL_NON_POOLING → DATABASE_URL → POSTGRES_PRISMA_URL → POSTGRES_URL.
 * Supabase는 Session pooler(5432)나 직접 연결을 쓴다 — Transaction pooler(6543)에서는 마이그레이션 잠금이 동작하지 않는다.
 * `prisma generate`는 DB 주소가 없어도 된다.
 */
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

const { url, directUrl } = databaseEnv(process.env);
const migrateUrl = directUrl ?? url ?? undefined;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(migrateUrl ? { datasource: { url: migrateUrl } } : {}),
});
