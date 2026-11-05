import { defineConfig } from "drizzle-kit";

// 앱(src/lib/db/config.ts)과 같은 규칙: DATABASE_*가 우선, 없으면 Vercel Turso 연동의 TURSO_*, 그것도 없으면 로컬 파일.
const url = process.env.DATABASE_URL?.trim() || process.env.TURSO_DATABASE_URL?.trim() || "file:./data/app.db";
const authToken = process.env.DATABASE_AUTH_TOKEN?.trim() || process.env.TURSO_AUTH_TOKEN?.trim() || undefined;

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: url.startsWith("libsql:") ? "turso" : "sqlite",
  dbCredentials: { url, authToken },
});
