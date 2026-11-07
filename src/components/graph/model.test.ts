import { describe, expect, it } from "vitest";
import type { CareerGraph, GraphNode } from "@/lib/domain/graph";
import { layoutGraph } from "./layout";
import {
  buildAddNodeOps,
  buildUpdateNodeOps,
  connectableTargets,
  describeEdge,
  displayProps,
  fieldsFor,
  formatPropValue,
  formValuesFrom,
  linkOptionsForNewNode,
  NEW_NODE_REF,
  nodePeriod,
  relationsBetween,
  sortNodesForList,
} from "./model";

const node = (id: string, label: GraphNode["label"], props: Record<string, unknown>, createdAt = 0) =>
  ({ id, label, props, createdAt, updatedAt: createdAt }) as GraphNode;

const company = node("c1", "Company", { name: "페이랩" }, 1);
const role = node("r1", "Role", { title: "백엔드 개발자", startDate: "2021-01", current: true }, 2);
const skill = node("s1", "Skill", { name: "Kotlin", category: "language" }, 3);
const graph: CareerGraph = {
  person: { id: "me", name: "홍길동" },
  nodes: [company, role, skill],
  edges: [
    { id: "WORKED_AT:me:c1", type: "WORKED_AT", from: "me", to: "c1" },
    { id: "AT_COMPANY:r1:c1", type: "AT_COMPANY", from: "r1", to: "c1" },
  ],
};

describe("fieldsFor", () => {
  it("대표 키가 맨 앞이고, 스키마에서 입력 종류를 고른다", () => {
    const role = fieldsFor("Role");
    expect(role[0]).toMatchObject({ key: "title", label: "직함", required: true });
    expect(role.find((f) => f.key === "startDate")?.kind).toBe("date");
    expect(role.find((f) => f.key === "current")?.kind).toBe("boolean");
    expect(role.find((f) => f.key === "summary")?.kind).toBe("textarea");
    expect(fieldsFor("Project").find((f) => f.key === "teamSize")?.kind).toBe("number");
    const cat = fieldsFor("Skill").find((f) => f.key === "category");
    expect(cat?.kind).toBe("select");
    expect(cat?.options?.find((o) => o.value === "language")?.label).toBe("언어");
    expect(fieldsFor("Company").find((f) => f.key === "url")?.kind).toBe("url");
  });
});

describe("buildAddNodeOps", () => {
  it("빈 값은 빼고 형 변환해 addNode(+연결)를 만든다", () => {
    const r = buildAddNodeOps(
      "Project",
      { ...formValuesFrom("Project"), name: " 결제 개편 ", teamSize: "5", startDate: "2022-03" },
      { type: "WORKED_ON", from: "me", to: NEW_NODE_REF },
    );
    expect(r).toEqual({
      ok: true,
      ops: [
        { op: "addNode", ref: NEW_NODE_REF, label: "Project", props: { name: "결제 개편", teamSize: 5, startDate: "2022-03" } },
        { op: "addEdge", type: "WORKED_ON", from: "me", to: NEW_NODE_REF },
      ],
    });
  });

  it("필수 값이 없거나 형식이 틀리면 필드 이름이 들어간 오류", () => {
    expect(buildAddNodeOps("Company", formValuesFrom("Company"))).toEqual({ ok: false, error: "회사명을(를) 입력해 주세요." });
    const bad = buildAddNodeOps("Role", { ...formValuesFrom("Role"), title: "PM", startDate: "21년 몇 월쯤" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("시작");
  });

  it("날짜는 계약대로 맞춘다: 2021/1 → 2021-01, 종료 '현재' → 진행 중, 미래·시작 > 종료는 오류", () => {
    const ok = buildAddNodeOps("Role", { ...formValuesFrom("Role"), title: "PM", startDate: "2021/1", endDate: "현재" });
    expect(ok).toEqual({ ok: true, ops: [{ op: "addNode", ref: NEW_NODE_REF, label: "Role", props: { title: "PM", startDate: "2021-01", current: true } }] });
    const future = buildAddNodeOps("Project", { ...formValuesFrom("Project"), name: "P", startDate: "2099-01" });
    expect(!future.ok && future.error).toContain("오늘 이후");
    const order = buildAddNodeOps("Project", { ...formValuesFrom("Project"), name: "P", startDate: "2024-05", endDate: "2023-01" });
    expect(!order.ok && order.error).toContain("늦어");
  });
});

describe("buildUpdateNodeOps", () => {
  it("바뀐 키만 담고, 비운 값·해제한 체크는 null(삭제)", () => {
    const values = { ...formValuesFrom("Role", role.props as Record<string, unknown>), current: false, endDate: "2024-06", startDate: "" };
    expect(buildUpdateNodeOps(role, values)).toEqual({
      ok: true,
      ops: [{ op: "updateNode", id: "r1", label: "Role", props: { current: null, endDate: "2024-06", startDate: null } }],
    });
  });

  it("바뀐 것이 없거나 대표 값을 비우면 오류", () => {
    const same = formValuesFrom("Role", role.props as Record<string, unknown>);
    expect(buildUpdateNodeOps(role, same)).toEqual({ ok: false, error: "바뀐 내용이 없습니다." });
    expect(buildUpdateNodeOps(role, { ...same, title: " " }).ok).toBe(false);
  });
});

describe("관계 후보", () => {
  it("허용 방향만, 이미 있는 관계는 빼고 양쪽 방향을 찾는다", () => {
    expect(relationsBetween(graph, "me", "c1")).toEqual([]); // WORKED_AT은 이미 있다
    expect(relationsBetween(graph, "r1", "s1")).toEqual([{ type: "USED_SKILL", from: "r1", to: "s1" }]);
    expect(relationsBetween(graph, "s1", "r1")).toEqual([{ type: "USED_SKILL", from: "r1", to: "s1" }]);
    expect(relationsBetween(graph, "me", "r1")).toEqual([{ type: "HAD_ROLE", from: "me", to: "r1" }]);
    expect(relationsBetween(graph, "c1", "s1")).toEqual([]);
    expect(connectableTargets(graph, "s1")).toEqual(["me", "r1"]);
  });

  it("새 노드 연결 선택지는 본인 연결이 먼저이고 설명이 붙는다", () => {
    const opts = linkOptionsForNewNode(graph, "Role");
    expect(opts[0]).toEqual({ type: "HAD_ROLE", from: "me", to: NEW_NODE_REF });
    expect(opts).toContainEqual({ type: "AT_COMPANY", from: NEW_NODE_REF, to: "c1" });
    expect(describeEdge(graph, opts[0]!, "PM")).toBe("직무: 나(홍길동) → PM");
  });
});

describe("표시", () => {
  it("기간·정렬·속성 표시", () => {
    expect(nodePeriod(role)).toBe("2021-01 ~ 현재");
    expect(nodePeriod(company)).toBeNull();
    const older = node("r0", "Role", { title: "인턴", startDate: "2019-07", endDate: "2019-12" });
    expect(sortNodesForList([older, role]).map((n) => n.id)).toEqual(["r1", "r0"]);
    expect(displayProps(skill)).toEqual([{ key: "category", label: "분류", value: "언어" }]);
    expect(displayProps(role).find((p) => p.key === "current")?.value).toBe("예");
  });
});

describe("자소서 소재 분류(tags)·STAR", () => {
  const project = node("p1", "Project", { name: "대시보드", categories: ["values", "collaboration"], situation: "정산이 느렸다" });

  it("Project fieldsFor에 tags 필드(선택지 8개)와 story 그룹", () => {
    const fields = fieldsFor("Project");
    const tags = fields.find((f) => f.key === "categories");
    expect(tags).toMatchObject({ kind: "tags", group: "story", maxItems: 3 });
    expect(tags?.options).toHaveLength(8);
    expect(tags?.options?.[1]).toEqual({ value: "collaboration", label: "협업·갈등 해결" });
    expect(fields.find((f) => f.key === "situation")).toMatchObject({ kind: "textarea", group: "story", label: "상황·목표(S·T)" });
    expect(fieldsFor("Experience").find((f) => f.key === "myRole")?.kind).toBe("text");
  });

  it("formValuesFrom은 배열을 정렬해 잇는다", () => {
    expect(formValuesFrom("Project", project.props as Record<string, unknown>).categories).toBe("collaboration,values");
  });

  it("buildUpdateNodeOps: 태그 변경은 배열, 모두 해제는 null, 순서만 다르면 변경 없음", () => {
    const base = formValuesFrom("Project", project.props as Record<string, unknown>);
    const changed = buildUpdateNodeOps(project, { ...base, categories: "leadership,collaboration" });
    expect(changed).toEqual({
      ok: true,
      ops: [{ op: "updateNode", id: "p1", label: "Project", props: { categories: ["collaboration", "leadership"] } }],
    });
    const cleared = buildUpdateNodeOps(project, { ...base, categories: "" });
    expect(cleared.ok && cleared.ops[0]!.op === "updateNode" && cleared.ops[0]!.props).toEqual({ categories: null });
    expect(buildUpdateNodeOps(project, { ...base, categories: "values,collaboration" })).toEqual({ ok: false, error: "바뀐 내용이 없습니다." });
    const added = buildAddNodeOps("Experience", { title: "동아리", categories: "learning" });
    expect(added.ok && added.ops[0]!.op === "addNode" && added.ops[0]!.props).toEqual({ title: "동아리", categories: ["learning"] });
  });

  it("formatPropValue·displayProps는 이름으로 바꾸고 story 그룹을 표시한다", () => {
    expect(formatPropValue("Project", "categories", ["collaboration", "values"])).toBe("협업·갈등 해결 · 성장과정·가치관(장단점 포함)");
    expect(formatPropValue("Skill", "category", "language")).toBe("언어");
    expect(displayProps(project).find((p) => p.key === "situation")).toMatchObject({ group: "story", value: "정산이 느렸다" });
  });
});

describe("layoutGraph", () => {
  it("본인은 가운데, 층마다 반지름이 커지고, 결정적이다", () => {
    const a = layoutGraph(graph);
    expect(a.positions.get("me")).toEqual({ x: 0, y: 0 });
    const dist = (id: string) => Math.hypot(a.positions.get(id)!.x, a.positions.get(id)!.y);
    expect(dist("c1")).toBeLessThan(dist("r1"));
    expect(dist("r1")).toBeLessThan(dist("s1"));
    expect(a.radii).toHaveLength(3);
    expect(layoutGraph(graph)).toEqual(a);
    const vb = a.viewBox;
    for (const p of a.positions.values()) {
      expect(p.x).toBeGreaterThan(vb.x);
      expect(p.x).toBeLessThan(vb.x + vb.width);
      expect(p.y).toBeGreaterThan(vb.y);
      expect(p.y).toBeLessThan(vb.y + vb.height);
    }
  });

  it("노드가 많으면 원을 키워 겹치지 않는다", () => {
    const many: CareerGraph = {
      person: { id: "me", name: null },
      nodes: Array.from({ length: 40 }, (_, i) => node(`k${i}`, "Skill", { name: `skill${i}` }, i)),
      edges: [],
    };
    const l = layoutGraph(many);
    const pts = [...l.positions.entries()].filter(([id]) => id !== "me").map(([, p]) => p);
    let min = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
    expect(min).toBeGreaterThan(60);
  });

  it("빈 그래프도 크기를 갖는다", () => {
    const l = layoutGraph({ person: { id: "me", name: null }, nodes: [], edges: [] });
    expect(l.positions.size).toBe(1);
    expect(l.viewBox.width).toBeGreaterThanOrEqual(300);
  });
});
