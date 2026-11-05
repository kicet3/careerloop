import { describe, expect, it } from "vitest";
import type { CareerGraph, GraphOp, NodeLabel } from "@/lib/domain/graph";
import { GraphOpError, planGraphOps } from "./plan";
import { graphToText } from "./text";

function ids() {
  let n = 0;
  return () => `id${++n}`;
}

describe("planGraphOps", () => {
  const existing = new Map<string, NodeLabel>([["c1", "Company"], ["r1", "Role"]]);

  it("임시 ref를 새 id로 풀고 관계를 해석한다", () => {
    const ops: GraphOp[] = [
      { op: "addNode", ref: "new:p", label: "Project", props: { name: "정산" } },
      { op: "addEdge", type: "WORKED_ON", from: "r1", to: "new:p" },
      { op: "addEdge", type: "PART_OF", from: "new:p", to: "c1" },
      { op: "updateNode", id: "r1", label: "Role", props: { endDate: null } },
    ];
    const { steps, created } = planGraphOps(existing, ops, ids());
    expect(created).toEqual({ "new:p": "id1" });
    expect(steps).toEqual([
      { kind: "create", id: "id1", label: "Project", props: { name: "정산" } },
      { kind: "link", type: "WORKED_ON", from: "r1", to: "id1" },
      { kind: "link", type: "PART_OF", from: "id1", to: "c1" },
      { kind: "update", id: "r1", label: "Role", props: { endDate: null } },
    ]);
  });

  it("없는 노드·다른 사용자 노드·틀린 방향·라벨 불일치·대표 이름 삭제를 막는다", () => {
    const bad: GraphOp[][] = [
      [{ op: "addEdge", type: "WORKED_AT", from: "me", to: "someone-elses" }],
      [{ op: "addEdge", type: "WORKED_AT", from: "c1", to: "me" }],
      [{ op: "addEdge", type: "WORKED_AT", from: "me", to: "r1" }],
      [{ op: "updateNode", id: "c1", label: "Role", props: { title: "x" } }],
      [{ op: "updateNode", id: "c1", label: "Company", props: { name: null } }],
      [{ op: "addEdge", type: "WORKED_AT", from: "me", to: "new:none" }],
      [{ op: "deleteNode", id: "c1" }, { op: "addEdge", type: "WORKED_AT", from: "me", to: "c1" }],
      [{ op: "deleteNode", id: "me" }],
    ];
    for (const ops of bad) expect(() => planGraphOps(existing, ops, ids())).toThrow(GraphOpError);
  });
});

describe("graphToText", () => {
  const graph: CareerGraph = {
    person: { id: "me", name: null },
    nodes: [
      { id: "c1", label: "Company", props: { name: "페이랩", industry: "핀테크" }, createdAt: 0, updatedAt: 0 },
      { id: "s1", label: "Skill", props: { name: "Kotlin" }, createdAt: 0, updatedAt: 0 },
    ],
    edges: [{ id: "WORKED_AT:me:c1", type: "WORKED_AT", from: "me", to: "c1" }],
  };
  it("라벨별 목록과 관계를 id와 함께 적는다", () => {
    const text = graphToText(graph);
    expect(text).toContain("- [c1] 페이랩 (industry=핀테크)");
    expect(text).toContain("나(me) -WORKED_AT(재직)-> 페이랩[c1]");
  });
  it("빈 그래프·글자 수 상한", () => {
    expect(graphToText({ ...graph, nodes: [], edges: [] })).toContain("없다");
    expect(graphToText(graph, { maxChars: 30 })).toContain("생략");
  });

  function bigGraph(projects: number): CareerGraph {
    const nodes: CareerGraph["nodes"] = [{ id: "c1", label: "Company", props: { name: "페이랩" }, createdAt: 0, updatedAt: 0 }];
    const edges: CareerGraph["edges"] = [{ id: "WORKED_AT:me:c1", type: "WORKED_AT", from: "me", to: "c1" }];
    for (let i = 0; i < projects; i++) {
      nodes.push({
        id: `p${i}`,
        label: "Project",
        props: { name: `프로젝트${i}`, summary: "긴 설명 ".repeat(60), myRole: "리드 ".repeat(30) },
        createdAt: 0,
        updatedAt: 0,
      });
      edges.push({ id: `PART_OF:p${i}:c1`, type: "PART_OF", from: `p${i}`, to: "c1" });
    }
    nodes.push({ id: "e1", label: "Education", props: { school: "한국대" }, createdAt: 0, updatedAt: 0 });
    nodes.push({ id: "z1", label: "Certification", props: { name: "정보처리기사" }, createdAt: 0, updatedAt: 0 });
    return { person: { id: "me", name: null }, nodes, edges };
  }

  it("그래프가 커져도 관계와 뒤쪽 라벨(학력·자격증)을 먼저 잃지 않는다: 속성을 줄여 맞춘다", () => {
    const text = graphToText(bigGraph(40), { maxChars: 12_000 });
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toContain("## 관계");
    expect(text).toContain("프로젝트39[p39] -PART_OF");
    expect(text).toContain("[e1] 한국대");
    expect(text).toContain("[z1] 정보처리기사");
  });

  it("이름만으로도 넘치면 구역마다 앞부분을 남기고 무엇을 몇 개 줄였는지 적는다", () => {
    const text = graphToText(bigGraph(400), { maxChars: 6000 });
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain("## 관계");
    expect(text).toContain("[e1] 한국대");
    expect(text).toContain("[z1] 정보처리기사");
    expect(text).toMatch(/생략: 프로젝트 \d+개/);
    expect(text).toMatch(/생략: 관계 \d+개/);
  });
});
