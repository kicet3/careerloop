/**
 * 사양 테스트 6(우회 경로)·13: 에이전트 경로 전체에서 Neo4j에 나가는 Cypher는 getCareerGraph의 두 고정 문장뿐이고(계획은 DB에 닿지 않는다),
 * executeRead + 트랜잭션 타임아웃을 쓰며, userId가 비면 실행하지 않는다. userId 없는 :Career 노드가 섞이면 읽기 전체가 실패한다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  runs: [] as { q: string; params: Record<string, unknown> }[],
  configs: [] as unknown[],
  nodes: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/graph/client", () => {
  const tx = {
    run: async (q: string, params: Record<string, unknown>) => {
      state.runs.push({ q, params });
      const recs = q.includes("properties(n)") ? state.nodes : [];
      return { records: recs.map((r) => ({ get: (k: string) => r[k] })) };
    },
  };
  return {
    graphEnabled: () => true,
    graphDatabase: () => undefined,
    ensureGraphSchema: async () => {},
    getDriver: () => ({
      session: () => ({
        executeRead: (fn: (t: typeof tx) => unknown, config?: unknown) => {
          state.configs.push(config);
          return fn(tx);
        },
        executeWrite: (fn: (t: typeof tx) => unknown) => fn(tx),
        close: async () => {},
      }),
    }),
  };
});

const node = (id: string, userId: string | undefined, name: string) => ({ id, label: "Project", props: { id, ...(userId ? { userId } : {}), name, createdAt: 1, updatedAt: 1 } });

let tdb: TestDb;
beforeAll(async () => {
  const { setupAgentDb } = await import("./__fixtures__/agent-harness.test-utils");
  ({ tdb } = await setupAgentDb());
});
afterAll(() => tdb.close());

describe("에이전트 경로의 Neo4j 문장", () => {
  it("스냅샷·최종 검증 재로딩 모두 getCareerGraph 고정 문장 2개뿐, executeRead + timeout", async () => {
    const { getCareerGraph } = await import("@/lib/graph/service");
    const { defaultAgentDeps, runAgentQa } = await import("./agent");
    const { A_ID, ScriptedLlm, callTools, evidenceIn, finalAnswer } = await import("./__fixtures__/two-users");
    state.nodes = [node("na_project", A_ID, "결제 시스템 개편")];
    state.runs = [];
    const llm = new ScriptedLlm((i, call) => {
      if (i === 0)
        return callTools(
          { tool: "resolve_entity", args: { text: "결제 시스템 개편" } },
          { tool: "query_graph", args: { plan: { start: { var: "p", label: "Project" }, hops: [{ rel: "USED_SKILL", dir: "out", to: { var: "s", label: "Skill" } }], return: { kind: "paths" } } } },
        );
      return finalAnswer([{ text: "결제 시스템 개편", kind: "fact", evidenceIds: [evidenceIn(call.user)[0]!.id] }]);
    });
    const out = await runAgentQa({
      userId: A_ID,
      threadId: "t",
      question: "결제 시스템 개편?",
      history: "",
      client: llm,
      deps: defaultAgentDeps((u) => getCareerGraph(u)),
      startedAt: Date.now(),
    });
    expect(out.kind).toBe("answer");
    const distinct = [...new Set(state.runs.map((r) => r.q.replace(/\s+/g, " ").trim()))];
    expect(distinct).toHaveLength(2);
    expect(distinct[0]).toMatch(/^MATCH \(n:Career \{userId: \$userId\}\)/);
    expect(distinct[1]).toMatch(/^MATCH \(a\)-\[r\]->\(b:Career \{userId: \$userId\}\) WHERE \(a:Career OR a:Person\) AND a\.userId = \$userId/);
    expect(state.runs).toHaveLength(4); // 시작 스냅샷 + 최종 검증 재로딩
    for (const r of state.runs) expect(r.params.userId).toBe(A_ID);
    for (const c of state.configs) expect(c).toMatchObject({ timeout: 5000 });
  });

  it("userId가 비면 쿼리 0회, userId 없는 :Career 노드가 섞이면 읽기 전체 실패(사양 13)", async () => {
    const { getCareerGraph } = await import("@/lib/graph/service");
    state.runs = [];
    await expect(getCareerGraph("")).rejects.toThrow();
    expect(state.runs).toHaveLength(0);
    state.nodes = [node("x", undefined, "주인 없음")];
    await expect(getCareerGraph("user_rag_a")).rejects.toMatchObject({ name: "GraphOwnerMismatchError" });
  });
});
