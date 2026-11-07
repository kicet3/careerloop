/**
 * Neo4j 통합(NEO4J_URI가 있을 때만, set -a; . ./.env.local; set +a): 사양 테스트 5 — A의 Skill과 B의 Skill을 잇는 :Shared:SkillConcept 노드와
 * 간선을 드라이버로 직접 심어도 getCareerGraph(A)·스냅샷에는 B 노드·공유 노드·공유 경유 간선이 없고, 계획 스키마로 만들 수 있는 모든 1~2홉 경로를
 * A 스냅샷에서 실행해도 B id가 나오지 않는다. 같은 이름(결제 시스템 개편·Kotlin)을 A·B가 함께 쓴다.
 */
import { nanoid } from "nanoid";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NODE_LABELS, REL_RULES, REL_TYPES, type EndpointLabel } from "@/lib/domain/graph";

vi.mock("server-only", () => ({}));

const enabled = Boolean(process.env.NEO4J_URI);
const userA = `test_rag_a_${nanoid(6)}`;
const userB = `test_rag_b_${nanoid(6)}`;

describe.skipIf(!enabled)("에이전트 스냅샷(Neo4j)", () => {
  afterAll(async () => {
    const { deleteUserGraph } = await import("@/lib/graph/service");
    const { closeDriver, getDriver, graphDatabase } = await import("@/lib/graph/client");
    await deleteUserGraph(userA);
    await deleteUserGraph(userB);
    const s = getDriver().session({ database: graphDatabase() });
    await s.run(`MATCH (x:Shared {key: $k}) DETACH DELETE x`, { k: `concept_${userA}` });
    await s.close();
    await closeDriver();
  });

  it("공유 노드를 심어도 A 스냅샷에 B·공유 노드가 없고, 모든 1~2홉 계획 결과에 B id가 없다", async () => {
    const { applyGraphOps, getCareerGraph } = await import("@/lib/graph/service");
    const { getDriver, graphDatabase } = await import("@/lib/graph/client");
    const { buildOwnedSnapshot } = await import("./snapshot");
    const { QueryPlanSchema, validatePlan } = await import("./graph/plan");
    const { evalPlan } = await import("./graph/eval-in-memory");
    const ops = (secret: string) =>
      [
        { op: "addNode", ref: "new:p", label: "Project", props: { name: "결제 시스템 개편", summary: secret } },
        { op: "addNode", ref: "new:s", label: "Skill", props: { name: "Kotlin" } },
        { op: "addNode", ref: "new:a", label: "Achievement", props: { summary: `성과 ${secret}` } },
        { op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
        { op: "addEdge", type: "USED_SKILL", from: "new:p", to: "new:s" },
        { op: "addEdge", type: "HAS_SKILL", from: "me", to: "new:s" },
        { op: "addEdge", type: "ACHIEVED", from: "new:p", to: "new:a" },
      ] as const;
    const a = await applyGraphOps(userA, ops("A-ONLY") as never);
    const b = await applyGraphOps(userB, ops("B-SECRET-7731") as never);
    // 공유 개념 노드를 드라이버로 직접 심어 A·B의 Skill을 잇는다(앱 쓰기 경로로는 만들 수 없는 구조).
    const s = getDriver().session({ database: graphDatabase() });
    await s.run(
      `MATCH (sa:Career {id: $sa, userId: $ua}), (sb:Career {id: $sb, userId: $ub})
       CREATE (c:Shared:SkillConcept {key: $k, name: 'Kotlin'})
       CREATE (sa)-[:HAS_SKILL]->(c), (sb)-[:HAS_SKILL]->(c), (c)-[:USED_SKILL]->(sb), (c)-[:RELATED_TO]->(sa)`,
      { sa: a.created["new:s"], sb: b.created["new:s"], ua: userA, ub: userB, k: `concept_${userA}` },
    );
    await s.close();

    const graph = await getCareerGraph(userA);
    const bIds = Object.values(b.created);
    const dump = JSON.stringify(graph);
    for (const id of bIds) expect(dump).not.toContain(id);
    expect(dump).not.toContain("B-SECRET-7731");
    expect(dump).not.toContain("SkillConcept");
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(4);
    const snap = buildOwnedSnapshot(graph, userA);

    const labels: EndpointLabel[] = [...NODE_LABELS, "Person"];
    const outputs: string[] = [];
    let count = 0;
    for (const from of labels)
      for (const rel of REL_TYPES)
        for (const dir of ["out", "in"] as const)
          for (const to of labels) {
            const ok = dir === "out" ? REL_RULES[rel].from.includes(from) && REL_RULES[rel].to.includes(to) : REL_RULES[rel].from.includes(to) && REL_RULES[rel].to.includes(from);
            if (!ok || (from === "Person" && to === "Person")) continue;
            for (const second of [null, ...REL_TYPES]) {
              const hops: unknown[] = [{ rel, dir, to: { var: "b", label: to } }];
              if (second) {
                const target = labels.find((l) => REL_RULES[second].from.includes(to) && REL_RULES[second].to.includes(l) && l !== "Person");
                if (!target) continue;
                hops.push({ rel: second, dir: "out", to: { var: "c", label: target } });
              }
              const r = validatePlan(QueryPlanSchema.parse({ start: { var: "a", label: from }, hops, return: { kind: "paths" } }), { snapshot: snap, resolveNodeHandle: () => null });
              if (!r.ok) continue;
              count++;
              outputs.push(JSON.stringify(evalPlan(r.plan, snap)));
            }
          }
    expect(count).toBeGreaterThan(50);
    const all = outputs.join("\n");
    for (const id of bIds) expect(all).not.toContain(id);
  });
});
