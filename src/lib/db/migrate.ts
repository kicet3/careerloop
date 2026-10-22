import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "file:./data/app.db";
  const file = sqliteFilePath(url);
  // 디렉터리가 있어야 클라이언트가 파일을 열 수 있으므로 client를 불러오기 전에 만든다.
  if (file) mkdirSync(path.dirname(file), { recursive: true });

  const [{ db }, { migrate }] = await Promise.all([import("./client"), import("drizzle-orm/libsql/migrator")]);
  await migrate(db, { migrationsFolder: migrationsFolder() });
  // SQLite는 연결마다 FK가 꺼져 있다. 현재 연결에 켜 둔다(ON DELETE CASCADE용).
  if (file) await db.$client.execute("PRAGMA foreign_keys = ON");
}

const globalForMigrate = globalThis as unknown as { __dbReady?: Promise<void> };

/**
 * 마이그레이션을 적용해 테이블을 보장한다. 프로세스당 1회만 실행(memoized)하며 여러 번 불러도 안전하다.
 * 실패하면 메모를 지워 다음 호출에서 다시 시도한다.
 */
export function ensureDatabase(): Promise<void> {
  globalForMigrate.__dbReady ??= run().catch((err) => {
    globalForMigrate.__dbReady = undefined;
    throw err;
  });
  return globalForMigrate.__dbReady;
}
