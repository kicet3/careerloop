import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { onVercel } from "@/lib/config/env-rules";
import { pgConnectionConfig, resolveDatabase } from "./config";

/**
 * Prisma 클라이언트(PostgreSQL, node-postgres 드라이버 어댑터). 운영은 Supabase Transaction pooler(6543) 주소를 쓴다 —
 * PrismaPg는 기본으로 prepared statement를 캐시하지 않아 트랜잭션 풀러에서도 동작한다.
 * 스키마는 prisma/schema.prisma, 마이그레이션은 prisma/migrations(배포 빌드의 scripts/migrate.mjs 또는 `npm run db:migrate`).
 *
 * `prisma`는 첫 사용 때 만든다(import만으로는 접속·환경 변수 검사를 하지 않는다). 개발 서버 HMR·따뜻한 람다에서 연결이
 * 계속 늘어나지 않도록 globalThis에 보관한다. 테스트(vitest)는 src/test/db.ts가 PGlite 클라이언트로 갈아 끼운다.
 */
function createPrismaClient(): PrismaClient {
  const { url } = resolveDatabase();
  const { connectionString, ssl, schema } = pgConnectionConfig(url);
  const adapter = new PrismaPg(
    {
      connectionString,
      ssl,
      // 서버리스 인스턴스마다 풀이 생기므로 작게 둔다(풀러가 실제 DB 연결을 나눠 쓴다).
      max: onVercel() ? 3 : 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    },
    {
      schema,
      onPoolError: (err) => console.error("[db] 연결 풀 오류", err),
    },
  );
  return new PrismaClient({ adapter });
}

const globalForDb = globalThis as unknown as {
  __prisma?: PrismaClient;
  /** 테스트 전용(src/test/db.ts). VITEST에서만 읽는다. */
  __prismaTest?: PrismaClient;
};

/** 현재 프로세스의 Prisma 클라이언트. */
export function getPrisma(): PrismaClient {
  if (process.env.VITEST) {
    if (globalForDb.__prismaTest) return globalForDb.__prismaTest;
    throw new Error("테스트 DB가 설치되지 않았습니다. src/test/db.ts의 createTestDb()를 먼저 호출하세요.");
  }
  return (globalForDb.__prisma ??= createPrismaClient());
}

/**
 * 앱 전역 Prisma 클라이언트. 실제 클라이언트에 위임하는 프록시라 모듈을 불러오는 시점에는 접속하지 않고,
 * 테스트가 파일·테스트마다 새 DB로 바꿔도 이미 불러온 모듈이 새 DB를 쓴다.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getPrisma();
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
  has(_target, prop) {
    return prop in getPrisma();
  },
});

/** 테스트 전용: 앱의 prisma를 주어진 클라이언트로 바꾼다(null이면 해제). VITEST 밖에서는 던진다. */
export function setPrismaForTests(client: PrismaClient | null): void {
  if (!process.env.VITEST) throw new Error("setPrismaForTests는 테스트(vitest)에서만 쓸 수 있습니다.");
  globalForDb.__prismaTest = client ?? undefined;
}

/** 스크립트·종료 처리용: 만든 연결을 닫는다(없으면 아무것도 하지 않는다). */
export async function disconnectPrisma(): Promise<void> {
  const client = globalForDb.__prisma;
  globalForDb.__prisma = undefined;
  await client?.$disconnect();
}

export { Prisma } from "@/generated/prisma/client";
export type { PrismaClient } from "@/generated/prisma/client";
/** 인터랙티브 트랜잭션 안의 클라이언트(prisma.$transaction(async (tx) => …)의 tx). */
export type Tx = Prisma.TransactionClient;
/** prisma 또는 트랜잭션 tx — 둘 다 받는 도우미 함수의 인자 타입. */
export type Db = PrismaClient | Tx;
