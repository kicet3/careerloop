import { describe, expect, it } from "vitest";
import { type CareerGraph, edgeId, type GraphNode, type RelType } from "@/lib/domain/graph";
import { qaGraph } from "./__fixtures__/qa-graph";
import { anchorOf, pathToText, personPaths } from "./paths";

const n = (id: string, label: GraphNode["label"], props: Record<string, unknown>): GraphNode =>
  ({ id, label, props, createdAt: 1, updatedAt: 1 }) as GraphNode;
const e = (type: RelType, from: string, to: string) => ({ id: edgeId(type, from, to), type, from, to });

function sample(): CareerGraph {
  return {
    person: { id: "me", name: "홍길동" },
    nodes: [
      n("c1", "Company", { name: "페이랩" }),
      n("r1", "Role", { title: "백엔드 개발자" }),
      n("p1", "Project", { name: "결제 개선" }),
      n("a1", "Achievement", { summary: "6시간→40분" }),
      n("s1", "Skill", { name: "Go" }),
      n("x1", "Skill", { name: "외톨이" }),
      n("p2", "Project", { name: "사이드" }),
      n("c2", "Company", { name: "넥스트" }),
    ],
    edges: [
      e("WORKED_AT", "me", "c1"),
      e("HAD_ROLE", "me", "r1"),
      e("AT_COMPANY", "r1", "c1"),
      e("WORKED_ON", "r1", "p1"),
      e("ACHIEVED", "p1", "a1"),
      e("USED_SKILL", "p1", "s1"),
      e("HAS_SKILL", "me", "s1"),
      e("WORKED_ON", "me", "p2"),
      e("PART_OF", "p2", "c2"),
    ],
  };
}

describe("personPaths", () => {
  it("설계 예시 경로: 나 → 페이랩(회사) → 백엔드 개발자(직무) → 결제 개선(프로젝트) → 6시간→40분(성과)", () => {
    const paths = personPaths(sample());
    expect(pathToText(paths.get("a1")!)).toBe("나 → 페이랩(회사) → 백엔드 개발자(직무) → 결제 개선(프로젝트) → 6시간→40분(성과)");
    expect(paths.get("a1")!.map((s) => s.rel)).toEqual([null, "WORKED_AT", "AT_COMPANY", "WORKED_ON", "ACHIEVED"]);
  });

  it("기술은 '쓴 곳'을 거친 경로를 선호한다(HAS_SKILL 1.8 < 1+1+1.5 이지만 직접 경로가 더 싸면 그쪽)", () => {
    // me -HAS_SKILL-> s1 (1.8) vs me→r1→p1→s1 (3.5): 직접 경로가 싸다.
    expect(pathToText(personPaths(sample()).get("s1")!)).toBe("나 → Go(기술)");
    const g = sample();
    g.edges = g.edges.filter((x) => x.type !== "HAS_SKILL");
    expect(pathToText(personPaths(g).get("s1")!)).toBe("나 → 페이랩(회사) → 백엔드 개발자(직무) → 결제 개선(프로젝트) → Go(기술)");
  });

  it("직무 없이 회사에 PART_OF로 붙은 프로젝트는 회사를 앞에 끼운다", () => {
    expect(pathToText(personPaths(sample()).get("p2")!)).toBe("나 → 넥스트(회사) → 사이드(프로젝트)");
  });

  it("본인과 이어지지 않은 노드", () => {
    const p = personPaths(sample()).get("x1")!;
    expect(p.map((s) => s.id)).toEqual(["me", "x1"]);
    expect(pathToText(p)).toBe("나 ⋯ 외톨이(기술) (나와 연결되지 않음)");
  });

  it("결정적이다(같은 입력 → 같은 경로), 앵커는 가장 가까운 프로젝트·경험", () => {
    const g = qaGraph();
    const a = personPaths(g);
    const b = personPaths(structuredClone(g));
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(anchorOf("a_settle", a.get("a_settle"))).toBe("p_payment");
    expect(anchorOf("r_backend", a.get("r_backend"))).toBe("r_backend");
    expect(anchorOf("a_award", a.get("a_award"))).toBe("e_hackathon");
  });
});
