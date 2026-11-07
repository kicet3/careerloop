/** 사양 테스트 13(소유권 없는 개인 데이터를 공개로 처리하지 않음): 스냅샷은 소유자 표시가 없거나 다르면, 끝점 없는 간선이 있으면 거부한다. */
import { describe, expect, it } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import { markGraphOwner } from "@/lib/graph/owner";
import { buildOwnedSnapshot } from "./snapshot";
import { A_ID, B_ID, graphA, memoryGraphs } from "./__fixtures__/two-users";

describe("buildOwnedSnapshot", () => {
  it("본인 표시 그래프 → 얼린 스냅샷(Person 포함, 간선 색인)", async () => {
    const s = buildOwnedSnapshot(await memoryGraphs().load(A_ID), A_ID);
    expect(s.nodes.get("me")?.label).toBe("Person");
    expect(s.nodes.size).toBe(6);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.nodes.get("na_project"))).toBe(true);
    expect(s.edgeKeys.has("na_project|ACHIEVED|na_ach")).toBe(true);
  });

  it("소유자 표시가 없거나(복사본·테스트 고정값) 다른 사용자면 unowned_node", async () => {
    const plain: CareerGraph = { person: { id: "me", name: null }, ...graphA() };
    expect(() => buildOwnedSnapshot(plain, A_ID)).toThrow("unowned_node");
    expect(() => buildOwnedSnapshot(markGraphOwner(plain, B_ID), A_ID)).toThrow("unowned_node");
    expect(() => buildOwnedSnapshot(markGraphOwner({ ...plain }, ""), "")).toThrow("unowned_node");
  });

  it("끝점이 노드 집합에 없는 간선 → unowned_node", () => {
    const g = graphA();
    g.edges.push({ id: "x", type: "ACHIEVED", from: "na_project", to: "nb_ach" });
    expect(() => buildOwnedSnapshot(markGraphOwner<CareerGraph>({ person: { id: "me", name: null }, ...g }, A_ID), A_ID)).toThrow("unowned_node");
  });
});
