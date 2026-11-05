import "server-only";
/**
 * Neo4j 드라이버 싱글턴. NEO4J_URI가 없으면 그래프 기능을 끈다(graphEnabled()=false) — 화면은 안내만 보인다.
 * 드라이버는 연결 풀을 갖고 있으므로 프로세스당 하나만 만들고, 개발 서버 HMR에서도 늘어나지 않게 globalThis에 둔다.
 */
import neo4j, { type Driver } from "neo4j-driver";
import { GraphUnavailableError } from "./errors";

export { GraphUnavailableError };

export function graphEnabled(): boolean {
  return Boolean(process.env.NEO4J_URI?.trim());
}

const globalForGraph = globalThis as unknown as { __neo4j?: Driver; __neo4jSchema?: Promise<void> };

export function getDriver(): Driver {
  if (!graphEnabled()) throw new GraphUnavailableError();
  globalForGraph.__neo4j ??= neo4j.driver(
    process.env.NEO4J_URI!.trim(),
    neo4j.auth.basic(process.env.NEO4J_USER?.trim() || "neo4j", process.env.NEO4J_PASSWORD ?? ""),
    // 정수를 JS number로 받는다(우리 값은 모두 안전 범위 안: 팀 규모·epoch ms).
    { disableLosslessIntegers: true, connectionAcquisitionTimeout: 10_000, maxConnectionPoolSize: 20 },
  );
  return globalForGraph.__neo4j;
}

/** NEO4J_DATABASE가 있으면 그 데이터베이스, 없으면 서버 기본값. */
export function graphDatabase(): string | undefined {
  return process.env.NEO4J_DATABASE?.trim() || undefined;
}

/**
 * 제약조건·인덱스를 보장한다(IF NOT EXISTS라 반복 실행해도 안전). 프로세스당 1회 memoized, 실패하면 다음 호출에서 재시도.
 * - (:Career {id}) 유일 — 사용자 노드는 모두 Career 라벨을 함께 갖는다
 * - (:Person {userId}) 유일
 * - (:Career {userId}) 인덱스
 */
export function ensureGraphSchema(): Promise<void> {
  globalForGraph.__neo4jSchema ??= (async () => {
    const driver = getDriver();
    const database = graphDatabase();
    for (const q of [
      "CREATE CONSTRAINT career_node_id IF NOT EXISTS FOR (n:Career) REQUIRE n.id IS UNIQUE",
      "CREATE CONSTRAINT person_user_id IF NOT EXISTS FOR (p:Person) REQUIRE p.userId IS UNIQUE",
      "CREATE INDEX career_node_user IF NOT EXISTS FOR (n:Career) ON (n.userId)",
    ]) {
      await driver.executeQuery(q, {}, { database });
    }
  })().catch((err) => {
    globalForGraph.__neo4jSchema = undefined;
    throw err;
  });
  return globalForGraph.__neo4jSchema;
}

/** 테스트·종료용. */
export async function closeDriver(): Promise<void> {
  const d = globalForGraph.__neo4j;
  globalForGraph.__neo4j = undefined;
  globalForGraph.__neo4jSchema = undefined;
  await d?.close();
}
