/** planGraphOps 날짜 계약: 모든 쓰기 경로(직접 편집·채팅 적용·가져오기)가 지나는 서버 검사. */
import { describe, expect, it } from "vitest";
import type { GraphOp, NodeLabel } from "@/lib/domain/graph";
import { GraphOpError, planGraphOps, sanitizeOpDates } from "./plan";

const TODAY = "2026-11-07";
const ids = () => {
  let n = 0;
  return () => `id${++n}`;
};
const existing = new Map<string, NodeLabel>([
  ["r1", "Role"],
  ["p1", "Project"],
  ["x1", "Experience"],
]);
const existingProps = new Map<string, Record<string, unknown>>([
  ["r1", { startDate: "2025-10", current: true }],
  ["p1", { startDate: "2024-05", endDate: "2024-09" }],
  ["x1", { startDate: "2019-03-04", endDate: "2020-10-03" }],
]);
const plan = (ops: GraphOp[]) => planGraphOps(existing, ops, ids(), { today: TODAY, existingProps });

describe("planGraphOps — 날짜", () => {
  it("YYYY-MM-DD는 YYYY-MM으로 줄여 저장하고, 종료 '현재'는 current로", () => {
    const { steps } = plan([
      { op: "addNode", ref: "new:a", label: "Project", props: { name: "A", startDate: "2024-03-15" } },
      { op: "updateNode", id: "p1", label: "Project", props: { endDate: "현재" } as never },
    ]);
    expect(steps).toEqual([
      { kind: "create", id: "id1", label: "Project", props: { name: "A", startDate: "2024-03" } },
      { kind: "update", id: "p1", label: "Project", props: { current: true, endDate: null } },
    ]);
  });

  it("옛 형식 다시 쓰기는 그 라벨의 속성 키만(스키마 밖 키는 쓰지 않는다)", () => {
    const { steps } = planGraphOps(new Map([["s1", "Skill" as NodeLabel]]), [{ op: "updateNode", id: "s1", label: "Skill", props: { name: "Go" } } as GraphOp], ids(), {
      today: TODAY,
      existingProps: new Map([["s1", { startDate: "2019-03-04" }]]),
    });
    expect(steps).toEqual([{ kind: "update", id: "s1", label: "Skill", props: { name: "Go" } }]);
  });

  it("시작 > 종료(기존 값과 비교 포함)·미래 날짜는 GraphOpError — 아무것도 쓰지 않는다", () => {
    const bad: GraphOp[][] = [
      [{ op: "addNode", ref: "new:a", label: "Project", props: { name: "A", startDate: "2024-05", endDate: "2023-01" } }],
      [{ op: "updateNode", id: "p1", label: "Project", props: { endDate: "2024-01" } }],
      [{ op: "addNode", ref: "new:a", label: "Project", props: { name: "A", startDate: "2027-01" } }],
      [{ op: "updateNode", id: "r1", label: "Role", props: { startDate: "2026-12" } }],
    ];
    for (const ops of bad) expect(() => plan(ops), JSON.stringify(ops)).toThrow(GraphOpError);
    expect(() => plan(bad[2]!)).toThrow(/오늘 이후/);
    expect(() => plan(bad[1]!)).toThrow(/늦어/);
  });

  it("같은 변경안에서 만든 노드의 날짜도 이어서 본다", () => {
    expect(() =>
      plan([
        { op: "addNode", ref: "new:a", label: "Project", props: { name: "A", startDate: "2024-05" } },
        { op: "updateNode", id: "new:a", label: "Project", props: { endDate: "2024-01" } },
      ]),
    ).toThrow(GraphOpError);
  });

  it("종료일을 주면 기존 진행 중을 지운다", () => {
    const { steps } = plan([{ op: "updateNode", id: "r1", label: "Role", props: { endDate: "2026-06" } }]);
    expect(steps).toEqual([{ kind: "update", id: "r1", label: "Role", props: { endDate: "2026-06", current: null } }]);
  });

  it("옛 형식 날짜는 그 노드를 고칠 때 함께 다시 쓴다(멱등 write-back)", () => {
    const { steps } = plan([{ op: "updateNode", id: "x1", label: "Experience", props: { myRole: "분대장" } }]);
    expect(steps).toEqual([{ kind: "update", id: "x1", label: "Experience", props: { myRole: "분대장", startDate: "2019-03", endDate: "2020-10" } }]);
  });

  it("existingProps 없이도(기존 호출) 이번 연산 값으로 검사한다", () => {
    expect(planGraphOps(existing, [{ op: "updateNode", id: "p1", label: "Project", props: { startDate: "2024-03-01" } }], ids(), { today: TODAY }).steps).toEqual([
      { kind: "update", id: "p1", label: "Project", props: { startDate: "2024-03" } },
    ]);
  });
});

describe("sanitizeOpDates — 변경안 정리(연산은 살리고 날짜만 뺀다)", () => {
  it("기존 값과 순서가 어긋난 날짜만 빼고, 남은 게 없는 updateNode는 뺀다", () => {
    const graph = new Map([["p1", { label: "Project" as const, props: { startDate: "2024-05" } }]]);
    const r = sanitizeOpDates(
      [
        { op: "updateNode", id: "p1", label: "Project", props: { endDate: "2024-01", action: "정산 배치를 짰다" } },
        { op: "updateNode", id: "p1", label: "Project", props: { endDate: "2023-12" } },
      ],
      graph,
      TODAY,
    );
    expect(r.ops).toEqual([{ op: "updateNode", id: "p1", label: "Project", props: { action: "정산 배치를 짰다" } }]);
    expect(r.dropped.map((d) => d.issues.map((i) => i.reason))).toEqual([["order"], ["order"]]);
  });
});
