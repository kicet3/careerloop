#!/usr/bin/env node
/**
 * 배포용 DB 마이그레이션(prisma/migrations)을 `prisma migrate deploy`로 적용한다. Vercel 빌드(vercel.json buildCommand →
 * npm run vercel-build)가 `next build` 뒤에 부른다. 런타임은 마이그레이션을 적용하지 않는다 — 인스턴스마다 동시에 적용하는
 * 경쟁과 Preview 배포가 운영 DB를 먼저 바꾸는 일을 막기 위해서다.
 *
 * - Vercel Production 빌드(VERCEL_ENV=production): 적용한다.
 * - Vercel Preview·Development 빌드: MIGRATE_ON_BUILD=1일 때만 적용한다(Preview 전용 DB를 따로 둔 경우에만 켜세요).
 * - Vercel 밖(직접 실행, `npm run db:migrate`): 적용한다.
 *
 * 주소 규칙은 prisma.config.ts·src/lib/config/env-rules.ts와 같다:
 * DIRECT_URL → POSTGRES_URL_NON_POOLING → DATABASE_URL → POSTGRES_PRISMA_URL → POSTGRES_URL.
 * Supabase는 Session pooler(5432)나 직접 연결 주소를 DIRECT_URL에 넣으세요(Transaction pooler 6543에서는 마이그레이션 잠금이 동작하지 않는다).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const onVercel = Boolean(env.VERCEL?.trim());

if (onVercel && env.VERCEL_ENV !== "production" && env.MIGRATE_ON_BUILD !== "1") {
  console.log(`[migrate] VERCEL_ENV=${env.VERCEL_ENV ?? "?"}: 건너뜀(Preview 전용 DB면 MIGRATE_ON_BUILD=1).`);
  process.exit(0);
}

// 로컬 실행 편의: prisma.config.ts와 같이 .env.local·.env를 읽는다(이미 있는 환경 변수는 덮어쓰지 않는다).
if (!onVercel) {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(root, file);
    if (existsSync(p)) process.loadEnvFile(p);
  }
}

const pick = (...keys) => keys.map((k) => env[k]?.trim()).find(Boolean);
const url = pick("DIRECT_URL", "POSTGRES_URL_NON_POOLING", "DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL");
if (!url) {
  console.error("[migrate] DATABASE_URL(또는 DIRECT_URL)이 없습니다. 빌드 환경 변수에 Supabase PostgreSQL 주소를 넣어 주세요.");
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//i.test(url)) {
  console.error("[migrate] DB 주소는 postgres:// 또는 postgresql:// 여야 합니다(SQLite file:·Turso libsql: 주소는 더 이상 쓰지 않습니다).");
  process.exit(1);
}

let where = "(해석할 수 없는 주소)";
let host = "";
try {
  const u = new URL(url);
  host = u.hostname.toLowerCase();
  where = `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
} catch {}
if (onVercel && (host === "localhost" || host.startsWith("127."))) {
  console.error(`[migrate] Vercel 빌드에서는 localhost DB(${where})에 닿을 수 없습니다. Supabase 주소를 넣어 주세요.`);
  process.exit(1);
}
if (host.endsWith(".pooler.supabase.com") && /:6543\//.test(`${where}/`)) {
  console.warn("[migrate] Transaction pooler(6543)로 마이그레이션합니다. 실패하면 DIRECT_URL에 Session pooler(5432) 주소를 넣으세요.");
}

const prismaBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma");
const res = spawnSync(prismaBin, ["migrate", "deploy"], {
  cwd: root,
  stdio: "inherit",
  // prisma.config.ts는 DIRECT_URL을 먼저 본다 — 위에서 고른 주소를 그대로 쓰게 넘긴다.
  env: { ...env, DIRECT_URL: url },
});
if (res.error) {
  console.error("[migrate] prisma를 실행하지 못했습니다:", res.error);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`[migrate] 마이그레이션 실패(${where}).`);
  process.exit(res.status ?? 1);
}
console.log(`[migrate] 적용 완료: ${where}`);
