/**
 * 테스트용 DB: 프로세스 안의 PGlite(WASM PostgreSQL)에 prisma/migrations의 SQL을 적용하고, 앱의 `prisma`
 * (src/lib/db/client.ts)가 이 DB를 쓰게 갈아 끼운다. Docker·DATABASE_URL이 필요 없다.
 * 테스트 파일에서만 불러온다(ESLint no-restricted-imports가 앱 코드의 @/test/** 사용을 막는다).
 *
 *   let tdb: TestDb;
 *   beforeAll(async () => { tdb = await createTestDb(); });   // 파일마다 새 DB
 *   afterEach(() => tdb.reset());                              // (선택) 테스트마다 비우기
 *   afterAll(() => tdb.close());
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "@/generated/prisma/client";
import { setPrismaForTests } from "@/lib/db/client";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");

/** prisma/migrations/<이름>/migration.sql 을 이름 순서대로. */
export function migrationSql(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => readFileSync(path.join(dir, name, "migration.sql"), "utf8"));
}

export interface TestDb {
  /** 이 DB에 붙은 Prisma 클라이언트(앱의 `prisma`도 같은 DB를 가리킨다). 행을 심을 때 쓴다. */
  prisma: PrismaClient;
  /** 원시 SQL이 필요할 때(예: information_schema 조회). */
  pglite: PGlite;
  /** 모든 테이블을 비우고 자동 증가 id를 1부터 다시 센다. */
  reset(): Promise<void>;
  /** 연결을 닫고 앱의 prisma 교체를 해제한다. */
  close(): Promise<void>;
}

/** 새 메모리 DB를 만들고 마이그레이션을 적용한 뒤 앱의 prisma로 설치한다. 다시 부르면 이전 DB를 대체한다. */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  for (const sql of migrationSql()) await pglite.exec(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
  setPrismaForTests(prisma);

  const tables = (
    await pglite.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
  ).rows.map((r) => `"${r.tablename}"`);

  return {
    prisma,
    pglite,
    async reset() {
      if (tables.length) await pglite.exec(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    },
    async close() {
      setPrismaForTests(null);
      await prisma.$disconnect();
      if (!pglite.closed) await pglite.close();
    },
  };
}
