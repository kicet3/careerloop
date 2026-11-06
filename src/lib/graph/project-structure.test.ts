import { describe, expect, it } from "vitest";
import { type CareerGraph, edgeId, type GraphOp } from "@/lib/domain/graph";
import { qaGraph } from "./__fixtures__/qa-graph";
import {
  assessProjectStructure,
  PROJECT_STRUCTURE_ITEMS,
  projectFocusText,
  projectSubgraph,
  restrictToFocus,
} from "./project-structure";

const states = (g: CareerGraph, id: string) => Object.fromEntries(assessProjectStructure(g, id)!.items.map((i) => [i.id, i.state]));

describe("프로젝트 구조화 체크리스트", () => {
  it("7개 항목을 정해진 순서로 판정하고, 다음에 물을 항목은 완료가 아닌 첫 항목", () => {
    const g = qaGraph();
    const s = assessProjectStructure(g, "p_payment")!;
    expect(s.items.map((i) => i.id)).toEqual(PROJECT_STRUCTURE_ITEMS.map((d) => d.id));
    expect(s).toMatchObject({ projectName: "결제 개선", total: 7, done: 6, next: "learned" });

    expect(states(g, "p_wiki")).toEqual({
      background: "done", // summary가 상황을 대신한다
      role: "missing",
      actions: "missing",
      skills: "done",
      results: "missing",
      context: "done",
      learned: "done",
    });
    expect(assessProjectStructure(g, "p_wiki")!.next).toBe("role");
    // 수치 성과는 Achievement 연결로도 채운다
    expect(states(g, "p_shop")).toMatchObject({ results: "done", actions: "missing", learned: "missing" });
  });

  it("일부(partial): 수치 없는 성과, 소속 없는 기간, 짧은 글", () => {
    const g = qaGraph();
    const p = g.nodes.find((n) => n.id === "p_payment")!;
    Object.assign(p.props, { result: "잘 됐다", learned: "많이 배움", action: "함" });
    g.edges = g.edges.filter((e) => !(e.type === "ACHIEVED" && e.from === "p_payment") && !(e.type === "WORKED_ON" && e.to === "p_payment"));
    expect(states(g, "p_payment")).toMatchObject({ results: "partial", context: "partial", actions: "partial", learned: "partial" });
    // 소속만 있고 시작일이 없어도 일부
    g.edges.push({ id: edgeId("PART_OF", "p_payment", "c_paylab"), type: "PART_OF", from: "p_payment", to: "c_paylab" });
    delete (p.props as Record<string, unknown>).startDate;
    expect(states(g, "p_payment").context).toBe("partial");
  });

  it("이어진 Experience의 행동·성과도 한 일·성과로 센다", () => {
    const g = qaGraph();
    g.edges.push({ id: edgeId("RELATED_TO", "e_hackathon", "p_wiki"), type: "RELATED_TO", from: "e_hackathon", to: "p_wiki" });
    expect(states(g, "p_wiki")).toMatchObject({ actions: "done", results: "partial" }); // '대상'은 수치가 아니다
  });

  it("프로젝트가 속한 Experience(PART_OF)는 소속으로만 세고, 그 경험의 행동·성과는 이 프로젝트 것으로 세지 않는다", () => {
    const g = qaGraph();
    g.edges = g.edges.filter((e) => !(e.type === "WORKED_ON" && e.to === "p_wiki"));
    g.edges.push({ id: edgeId("PART_OF", "p_wiki", "e_club"), type: "PART_OF", from: "p_wiki", to: "e_club" });
    g.edges.push({ id: edgeId("ACHIEVED", "e_club", "a_dash"), type: "ACHIEVED", from: "e_club", to: "a_dash" });
    expect(states(g, "p_wiki")).toMatchObject({ actions: "missing", results: "missing", context: "done" });
    // 소속 경험의 성과는 주변 그래프로 퍼지지 않는다
    expect(projectSubgraph(g, "p_wiki")!.nodes.map((n) => n.id)).not.toContain("a_dash");
    // 소속 경험은 기준점이 아니다: 그 경험을 다른 프로젝트에 잇는 연산은 뺀다
    const out = restrictToFocus([{ op: "addEdge", type: "RELATED_TO", from: "e_club", to: "p_dashboard" }], g, "p_wiki");
    expect(out.ops).toEqual([]);
  });

  it("Project가 아니거나 없는 노드는 null", () => {
    expect(assessProjectStructure(qaGraph(), "e_club")).toBeNull();
    expect(assessProjectStructure(qaGraph(), "nope")).toBeNull();
    expect(projectSubgraph(qaGraph(), "nope")).toBeNull();
    expect(projectFocusText(qaGraph(), "nope")).toBeNull();
  });
});

describe("프로젝트 주변 그래프", () => {
  it("이웃과 Role의 회사까지 담고, 기술·직무를 거쳐 다른 프로젝트로 퍼지지 않는다", () => {
    const sub = projectSubgraph(qaGraph(), "p_payment")!;
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(["a_fail", "a_settle", "c_paylab", "p_payment", "r_backend", "s_go", "s_kafka"]);
    expect(sub.edges.some((e) => e.to === "p_dashboard")).toBe(false);
    expect(sub.edges.some((e) => e.type === "HAD_ROLE" && e.to === "r_backend")).toBe(true);
  });

  it("프롬프트 텍스트: 프로젝트 id, 긴 속성, 체크리스트(빠진 항목의 질문)", () => {
    const text = projectFocusText(qaGraph(), "p_payment")!;
    expect(text).toContain("구조화할 프로젝트: [p_payment] 결제 개선");
    expect(text).toContain("[r_backend] 백엔드 개발자");
    expect(text).toContain("situation=월말마다 정산 배치가 6시간 넘게 걸려 다음 날 업무가 밀렸다");
    expect(text).not.toContain("p_dashboard");
    expect(text).toContain("구조화 6/7 완료 · 다음에 물을 항목: 배운 점");
    expect(text).toMatch(/\[없음\] learned\(배운 점\).*물을 질문: .*넣을 곳: Project\.learned/);
  });

  it("프로젝트 자체 속성은 자르지 않고 원문 그대로, 주변 그래프에서 잘린 값에는 표시를 남긴다", () => {
    const g = qaGraph();
    const long = `${"가".repeat(1500)}끝`;
    Object.assign(g.nodes.find((n) => n.id === "p_payment")!.props, { summary: long });
    const text = projectFocusText(g, "p_payment")!;
    expect(text).toContain(`- summary: ${long}`);
    expect(text).toContain("…(잘림)");
  });
});

describe("변경안 범위 검사(restrictToFocus)", () => {
  const g = qaGraph();
  const run = (ops: GraphOp[]) => restrictToFocus(ops, g, "p_payment");

  it("프로젝트 속성 수정과 프로젝트에 이은 새 노드(사슬 포함)는 남긴다", () => {
    const ops: GraphOp[] = [
      { op: "updateNode", id: "p_payment", label: "Project", props: { learned: "이벤트 기반 설계의 장단점을 배웠다" } },
      { op: "addNode", ref: "new:s", label: "Skill", props: { name: "Redis" } },
      { op: "addEdge", type: "USED_SKILL", from: "p_payment", to: "new:s" },
      { op: "addNode", ref: "new:e", label: "Experience", props: { title: "장애 대응" } },
      { op: "addEdge", type: "HAS_EXPERIENCE", from: "me", to: "new:e" },
      { op: "addEdge", type: "RELATED_TO", from: "new:e", to: "p_payment" },
      { op: "addNode", ref: "new:a", label: "Achievement", props: { summary: "장애 0건", value: "0건" } },
      { op: "addEdge", type: "ACHIEVED", from: "new:e", to: "new:a" },
      // 범위 안 노드끼리(직무의 회사), 기존 기술 연결과 그 기술 수정
      { op: "addEdge", type: "USED_SKILL", from: "p_payment", to: "s_aws" },
      { op: "updateNode", id: "s_aws", label: "Skill", props: { level: "실무" } },
      { op: "updateNode", id: "a_settle", label: "Achievement", props: { metric: "배치 시간" } },
    ];
    const out = run(ops);
    expect(out.dropped).toEqual([]);
    expect(out.ops).toEqual(ops);
  });

  it("프로젝트와 무관한 연산은 사유와 함께 뺀다", () => {
    const out = run([
      { op: "updateNode", id: "p_dashboard", label: "Project", props: { learned: "x" } },
      { op: "addNode", ref: "new:x", label: "Experience", props: { title: "무관한 경험" } },
      { op: "addEdge", type: "HAS_EXPERIENCE", from: "me", to: "new:x" },
      // 기술(허브)을 거쳐서는 이어지지 않는다
      { op: "addNode", ref: "new:y", label: "Experience", props: { title: "Go 스터디" } },
      { op: "addEdge", type: "USED_SKILL", from: "new:y", to: "s_go" },
      { op: "addEdge", type: "USED_SKILL", from: "p_dashboard", to: "s_go" },
      { op: "addNode", ref: "new:p", label: "Project", props: { name: "새 프로젝트" } },
      { op: "addEdge", type: "WORKED_ON", from: "r_backend", to: "new:p" },
      { op: "deleteNode", id: "p_payment" },
      { op: "deleteNode", id: "e_club" },
      { op: "addEdge", type: "HAS_SKILL", from: "me", to: "s_react" },
    ]);
    expect(out.ops).toEqual([]);
    expect(out.dropped).toHaveLength(11);
    expect(out.dropped.join("\n")).toContain("새 프로젝트를 만들지 않습니다");
    expect(out.dropped.join("\n")).toContain("프로젝트 자체는 이 대화에서 지우지 않습니다");
    expect(out.dropped[0]).toContain("주문 대시보드");
  });

  it("지우기는 이 프로젝트에만 딸린 노드만: 함께 쓰는 직무·회사는 지우지 않는다", () => {
    const out = run([
      { op: "deleteNode", id: "a_fail" },
      { op: "deleteNode", id: "r_backend" },
      { op: "deleteNode", id: "c_paylab" },
      { op: "deleteEdge", type: "WORKED_ON", from: "r_backend", to: "p_payment" },
    ]);
    expect(out.ops).toEqual([
      { op: "deleteNode", id: "a_fail" },
      { op: "deleteEdge", type: "WORKED_ON", from: "r_backend", to: "p_payment" },
    ]);
    expect(out.dropped).toHaveLength(2);
    expect(out.dropped.join("\n")).toContain("다른 경험과도 이어진 항목");
  });

  it("새 노드를 거쳐 무관한 노드를 잇거나 고치지 않는다", () => {
    const out = run([
      { op: "addNode", ref: "new:a", label: "Achievement", props: { summary: "x", value: "1건" } },
      { op: "addEdge", type: "ACHIEVED", from: "p_payment", to: "new:a" },
      { op: "addEdge", type: "ACHIEVED", from: "r_intern", to: "new:a" },
      { op: "updateNode", id: "r_intern", label: "Role", props: { title: "x" } },
    ]);
    expect(out.ops.map((o) => o.op)).toEqual(["addNode", "addEdge"]);
    expect(out.dropped).toHaveLength(2);
  });

  it("프로젝트가 사라졌으면 모두 뺀다", () => {
    const out = restrictToFocus([{ op: "updateNode", id: "gone", label: "Project", props: { learned: "x" } }], g, "gone");
    expect(out.ops).toEqual([]);
    expect(out.dropped[0]).toContain("찾을 수 없습니다");
  });
});
