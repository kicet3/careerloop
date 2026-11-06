/**
 * Neo4j 없이 그래프 저장소(service.ts)의 사용자 격리를 본다. 드라이버를 가짜로 바꿔 실행한 Cypher·파라미터를 기록한다.
 * - 모든 쿼리가 $userId 조건을 걸고 요청 사용자 id를 넘긴다(다른 사용자 노드에 닿지 않는다).
 * - 쿼리가 잘못 바뀌어 다른 사용자 노드가 섞여 나오면 getCareerGraph는 그래프 전체를 버린다.
 * - 읽은 그래프에는 요청 사용자 소유 표시가 붙는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Rec = Record<string, unknown>;
const state = vi.hoisted(() => ({
  runs: [] as { q: string; params: Record<string, unknown> }[],
  /** 쿼리 문자열 → 돌려줄 레코드 */
  respond: (() => []) as (q: string, p: Record<string, unknown>) => Record<string, unknown>[],
}));

vi.mock("./client", () => {
  const tx = {
    run: async (q: string, params: Record<string, unknown>) => {
      state.runs.push({ q, params });
      return { records: state.respond(q, params).map((r) => ({ get: (k: string) => r[k] })) };
    },
  };
  return {
    graphEnabled: () => true,
    graphDatabase: () => undefined,
    ensureGraphSchema: async () => {},
    getDriver: () => ({
      session: () => ({
        executeRead: (fn: (t: typeof tx) => unknown) => fn(tx),
        executeWrite: (fn: (t: typeof tx) => unknown) => fn(tx),
        close: async () => {},
      }),
    }),
  };
});

const { getCareerGraph, applyGraphOps, deleteNode, deleteUserGraph } = await import("./service");
const { graphOwnerOf } = await import("./owner");

const node = (id: string, userId: string, name: string): Rec => ({
  id,
  label: "Project",
  props: { id, userId, name, createdAt: 1, updatedAt: 1 },
});

beforeEach(() => {
  state.runs = [];
  state.respond = () => [];
});

function expectAllScopedTo(userId: string) {
  expect(state.runs.length).toBeGreaterThan(0);
  for (const r of state.runs) {
    expect(r.q, r.q).toMatch(/userId: \$userId|userId = \$userId/);
    expect(r.params.userId, r.q).toBe(userId);
  }
}

describe("그래프 저장소(Cypher): 요청 사용자 범위만", () => {
  it("getCareerGraph: 모든 쿼리가 userId로 걸러지고, 결과에 A 소유 표시가 붙는다", async () => {
    state.respond = (q) => (q.includes("RETURN n.id AS id") ? [node("p1", "A", "A 프로젝트")] : []);
    const g = await getCareerGraph("A");
    expectAllScopedTo("A");
    expect(g.nodes.map((n) => n.id)).toEqual(["p1"]);
    expect(graphOwnerOf(g)).toBe("A");
    // 내부 키(userId)는 노드 속성으로 나가지 않는다(LLM 프롬프트·API 응답에 다른 키가 실리지 않게).
    expect(JSON.stringify(g)).not.toContain('"userId"');
  });

  it("getCareerGraph: 다른 사용자 노드가 하나라도 섞이면 그래프 전체를 버린다(B 데이터 반환 없음)", async () => {
    state.respond = (q) => (q.includes("RETURN n.id AS id") ? [node("p1", "A", "A 프로젝트"), node("p2", "B", "ZQXBMARK")] : []);
    await expect(getCareerGraph("A")).rejects.toThrow(/다른 사용자/);
  });

  it("getCareerGraph: userId 속성이 없는 노드(소유 불명)도 받지 않는다", async () => {
    state.respond = (q) => (q.includes("RETURN n.id AS id") ? [{ id: "p9", label: "Project", props: { id: "p9", name: "ZQXBMARK" } }] : []);
    await expect(getCareerGraph("A")).rejects.toThrow(/다른 사용자/);
  });

  it("applyGraphOps·deleteNode·deleteUserGraph: 모든 읽기·쓰기 쿼리가 요청 사용자로 걸러진다", async () => {
    // A의 기존 노드는 p1뿐(B가 같은 id를 갖더라도 existingNodes는 A 범위만 본다).
    state.respond = (q) => {
      if (q.includes("RETURN n.id AS id, [l IN labels(n)")) return [{ id: "p1", label: "Project" }];
      if (q.includes("RETURN n.id")) return [{ "n.id": "p1" }];
      if (q.includes("RETURN 1 AS ok")) return [{ ok: 1 }];
      if (q.includes("count(*)")) return [{ c: 1 }];
      return [];
    };
    await applyGraphOps("A", [
      { op: "updateNode", id: "p1", label: "Project", props: { name: "x" } },
      { op: "addNode", ref: "new:s", label: "Skill", props: { name: "TS" } },
      { op: "addEdge", type: "USED_SKILL", from: "p1", to: "new:s" },
      { op: "addEdge", type: "WORKED_ON", from: "me", to: "p1" },
      { op: "deleteNode", id: "p1" },
    ] as never);
    await deleteNode("A", "p1");
    await deleteUserGraph("A");
    expectAllScopedTo("A");
    // 노드를 만들 때 userId를 사용자 입력 props가 아닌 요청 사용자로 덮어쓴다.
    const create = state.runs.find((r) => r.q.startsWith("CREATE"))!;
    expect(create.q).toContain("n.userId = $userId");
  });

  it("applyGraphOps: A 범위에 없는 id(B의 노드 id)는 쓰기 전에 거절한다", async () => {
    state.respond = (q) => (q.includes("RETURN n.id AS id, [l IN labels(n)") ? [{ id: "p1", label: "Project" }] : []);
    await expect(applyGraphOps("A", [{ op: "updateNode", id: "b_only", label: "Project", props: { name: "x" } }] as never)).rejects.toThrow();
    expect(state.runs.some((r) => r.q.includes("SET n +="))).toBe(false);
  });

  it("userId 없이는 쿼리를 실행하지 않는다", async () => {
    await expect(getCareerGraph("")).rejects.toThrow();
    await expect(deleteUserGraph("")).rejects.toThrow();
    expect(state.runs).toHaveLength(0);
  });
});
