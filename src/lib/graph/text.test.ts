import { describe, expect, it } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import { graphToText } from "./text";

describe("graphToText", () => {
  it("배열 속성은 a|b로, STAR 필드도 속성으로 쓴다", () => {
    const graph: CareerGraph = {
      person: { id: "me", name: null },
      nodes: [
        {
          id: "p1",
          label: "Project",
          props: { name: "대시보드", categories: ["collaboration", "leadership"], result: "처리 시간 3일→1일" },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      edges: [],
    };
    const text = graphToText(graph);
    expect(text).toContain("categories=collaboration|leadership");
    expect(text).toContain("result=처리 시간 3일→1일");
  });
});
