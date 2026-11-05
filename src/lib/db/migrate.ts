import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onVercel } from "@/lib/config/env-rules";
import { resolveDatabase } from "./config";

/** 로컬 SQLite 파일 URL이면 파일 경로, 아니면(libsql://, :memory: 등) null. */
export function sqliteFilePath(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  if (url.startsWith("file://")) return fileURLToPath(url.split("?")[0]!);
  const p = url.slice("file:".length).split("?")[0]!;
  if (!p || p === ":memory:") return null;
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), p);
}

export function migrationsFolder(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), "drizzle");
}

export class DatabaseSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSetupError";
  }
}

/** 마이그레이션 저널(drizzle/meta/_journal.json)의 가장 새 항목 시각(ms). drizzle 마이그레이터가 created_at에 쓰는 값이다. */
export function latestJournalMillis(folder: string = migrationsFolder()): number {
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: { when: number }[] };
  return Math.max(0, ...journal.entries.map((e) => e.when));
}

/**
 * 런타임에 마이그레이션을 직접 적용할지. 자체 호스팅·로컬은 적용한다(프로세스당 1회).
 * Vercel은 배포 때 한 번만 적용하고(scripts/migrate.mjs, vercel.json buildCommand) 런타임에는 확인만 한다 —
 * 새 인스턴스 여러 개가 동시에 같은 마이그레이션을 적용하는 경쟁, Preview 배포가 운영 DB를 먼저 바꾸는 일을 막는다.
 * DB_MIGRATE_AT_RUNTIME=1이면 Vercel에서도 예전처럼 런타임에 적용한다(빌드에서 DB에 닿을 수 없을 때의 탈출구).
 */
export function migrateAtRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return !onVercel(env) || env.DB_MIGRATE_AT_RUNTIME === "1";
}

async function run(): Promise<void> {
  const { url } = resolveDatabase();
  const file = sqliteFilePath(url);
  if (file && onVercel()) {
    // 배포 폴더(/var/task)는 읽기 전용이고 /tmp 파일은 인스턴스마다 따로라 데이터가 사라진다.
    throw new DatabaseSetupError(
      "Vercel에서는 로컬 SQLite 파일(file:) DB를 쓸 수 없습니다. DATABASE_URL=libsql://…(Turso)와 DATABASE_AUTH_TOKEN을 설정하세요.",
    );
  }
  // 디렉터리가 있어야 클라이언트가 파일을 열 수 있으므로 client를 불러오기 전에 만든다.
  if (file) mkdirSync(path.dirname(file), { recursive: true });

  const { db } = await import("./client");
  if (!migrateAtRuntime()) {
    await assertMigrated(db);
    return;
  }
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  await migrate(db, { migrationsFolder: migrationsFolder() });
  // SQLite는 연결마다 FK가 꺼져 있다. 현재 연결에 켜 둔다(ON DELETE CASCADE용).
  if (file) await db.$client.execute("PRAGMA foreign_keys = ON");
}

/** DB에 적용된 마지막 마이그레이션이 이 배포의 최신 마이그레이션보다 오래됐으면 DatabaseSetupError(쿼리 1회). */
async function assertMigrated(db: (typeof import("./client"))["db"]): Promise<void> {
  let applied = 0;
  try {
    const res = await db.$client.execute("SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1");
    applied = Number(res.rows[0]?.created_at ?? 0);
  } catch (err) {
    if (!/no such table/i.test(String((err as Error)?.message ?? err))) throw err;
  }
  if (applied < latestJournalMillis()) {
    throw new DatabaseSetupError(
      "DB 스키마가 이 배포보다 오래됐습니다. 배포 빌드의 마이그레이션(scripts/migrate.mjs)이 돌지 않았습니다 — " +
        "빌드 환경에 DATABASE_URL·DATABASE_AUTH_TOKEN이 있는지 확인하고 다시 배포하거나 `npm run db:migrate:deploy`를 실행하세요.",
    );
  }
}

const globalForMigrate = globalThis as unknown as { __dbReady?: Promise<void> };

/**
 * 테이블을 보장한다. 프로세스당 1회만 실행(memoized)하며 여러 번 불러도 안전하다.
 * 자체 호스팅은 마이그레이션을 적용하고, Vercel은 배포 때 적용된 것을 확인만 한다(migrateAtRuntime).
 * 실패하면 메모를 지워 다음 호출에서 다시 시도한다.
 */
export function ensureDatabase(): Promise<void> {
  globalForMigrate.__dbReady ??= run().catch((err) => {
    globalForMigrate.__dbReady = undefined;
    throw err;
  });
  return globalForMigrate.__dbReady;
}
