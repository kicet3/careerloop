/** MCP 도구 본문(순수): 요약·목록 페이지·노드 자세히·검색·전체 텍스트·체크리스트·스키마. */
import { describe, expect, it } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import { QA_NOW_YEAR, qaGraph } from "@/lib/graph/__fixtures__/qa-graph";
import {
  decodeCursor,
  EMPTY_GRAPH_OVERVIEW,
  encodeCursor,
  experienceChecklist,
  getNode,
  graphSchemaDocument,
  graphText,
  listNodes,
  McpToolError,
  profileSummary,
  searchGraph,
} from "./graph-tools";

const empty = (): CareerGraph => ({ person: { id: "me", name: null }, nodes: [], edges: [] });

describe("profileSummary", () => {
  it("라벨별 수·현재 직무와 회사·학력·많이 쓴 기술·체크리스트", () => {
    const s = profileSummary(qaGraph());
    expect(s.personName).toBe("홍길동");
    expect(s.totalNodes).toBe(25);
    expect(s.totalEdges).toBe(29);
    expect(s.counts).toMatchObject({ Company: 2, Role: 2, Project: 4, Experience: 2, Achievement: 5, Skill: 8, Education: 1, Certification: 1 });
    expect(s.currentRoles).toEqual([{ id: "r_backend", title: "백엔드 개발자", company: { id: "c_paylab", name: "페이랩" }, startDate: "2022-03" }]);
    expect(s.companies.map((c) => c.name)).toEqual(["페이랩", "넥스트커머스"]);
    expect(s.education).toEqual([{ id: "ed_univ", school: "한국대학교", degree: "학사", major: "컴퓨터공학", status: "졸업" }]);
    // React(2회)·커뮤니케이션(2회)이 앞, 나머지는 1회 — 이름 순.
    expect(s.topSkills.slice(0, 2).map((x) => [x.name, x.uses])).toEqual([
      ["React", 2],
      ["커뮤니케이션", 2],
    ]);
    expect(s.topSkills.length).toBeLessThanOrEqual(15);
    expect(s.checklist.requiredTotal).toBe(6);
    expect(s.lastUpdatedAt).toBe(new Date(1).toISOString());
    expect(s.overview).toContain("그래프 개요");
  });

  it("빈 그래프는 0과 안내 문구", () => {
    const s = profileSummary(empty());
    expect(s).toMatchObject({ totalNodes: 0, totalEdges: 0, currentRoles: [], topSkills: [], lastUpdatedAt: null, overview: EMPTY_GRAPH_OVERVIEW });
    expect(s.checklist.progress).toBe(0);
  });
});

describe("listNodes", () => {
  it("label로 거르고 커서로 이어 받는다", () => {
    const g = qaGraph();
    const p1 = listNodes(g, { label: "Skill", limit: 5 });
    expect(p1.total).toBe(8);
    expect(p1.items).toHaveLength(5);
    expect(p1.items[0]).toEqual({ id: "s_go", label: "Skill", labelName: "기술·역량", name: "Go", updatedAt: new Date(1).toISOString() });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listNodes(g, { label: "Skill", limit: 5, cursor: p1.nextCursor! });
    expect(p2.items.map((n) => n.id)).toEqual(["s_es", "s_aws", "s_comm"]);
    expect(p2.nextCursor).toBeNull();
  });

  it("includeProps면 화이트리스트 속성까지", () => {
    const g = qaGraph();
    (g.nodes[0]!.props as Record<string, unknown>).secret = "x";
    const r = listNodes(g, { limit: 1, includeProps: true });
    expect(r.items[0]).toMatchObject({ id: "c_paylab", props: { name: "페이랩", industry: "핀테크" } });
    expect((r.items[0] as { props: Record<string, unknown> }).props.secret).toBeUndefined();
  });

  it("잘못된 커서는 도구 오류", () => {
    expect(() => listNodes(qaGraph(), { cursor: "garbage" })).toThrow(McpToolError);
    expect(() => decodeCursor(Buffer.from('{"o":-1}').toString("base64url"))).toThrow(McpToolError);
    expect(decodeCursor(encodeCursor(40))).toBe(40);
  });
});

describe("getNode", () => {
  it("속성·경로·이웃", () => {
    const r = getNode(qaGraph(), { id: "p_payment" });
    expect(r.node).toMatchObject({ id: "p_payment", label: "Project", name: "결제 개선", props: { myRole: "백엔드 리드 개발" } });
    expect(r.path?.text).toBe("나 → 페이랩(회사) → 백엔드 개발자(직무) → 결제 개선(프로젝트)");
    expect(r.neighbors.map((n) => `${n.direction}:${n.type}:${n.node.id}`)).toEqual([
      "out:ACHIEVED:a_fail",
      "out:ACHIEVED:a_settle",
      "out:USED_SKILL:s_go",
      "out:USED_SKILL:s_kafka",
      "in:WORKED_ON:r_backend",
    ]);
    expect(r.neighbors.find((n) => n.type === "WORKED_ON")?.relName).toBe("프로젝트 수행");
    expect(r.neighborsTruncated).toBe(false);
  });

  it('"me"는 본인 — 경로 없음, 이웃 수 제한', () => {
    const r = getNode(qaGraph(), { id: "me", neighborLimit: 3 });
    expect(r.node).toMatchObject({ id: "me", label: "Person", name: "홍길동", props: {} });
    expect(r.path).toBeNull();
    expect(r.neighbors).toHaveLength(3);
    expect(r.neighborsTruncated).toBe(true);
    expect(r.neighbors.every((n) => n.direction === "out")).toBe(true);
  });

  it("없는 id는 도구 오류", () => {
    expect(() => getNode(qaGraph(), { id: "nope" })).toThrow("노드를 찾을 수 없습니다: nope");
  });
});

describe("searchGraph", () => {
  it("결정적 검색: 결제 성과 질문이면 결제 개선 쪽이 위", () => {
    const a = searchGraph(qaGraph(), { query: "결제 정산 성과가 뭐였어?" }, { nowYear: QA_NOW_YEAR });
    const b = searchGraph(qaGraph(), { query: "결제 정산 성과가 뭐였어?" }, { nowYear: QA_NOW_YEAR });
    expect(a).toEqual(b);
    expect(a.intents).toContain("achievement");
    const top3 = a.results.slice(0, 3).map((r) => r.id);
    expect(top3).toContain("a_settle");
    expect(a.results[0]).toMatchObject({ rank: 1 });
    expect(a.results[0]!.pathText.startsWith("나")).toBe(true);
    expect(Number.isFinite(a.results[0]!.score)).toBe(true);
  });

  it("limit과 기술 인식", () => {
    const r = searchGraph(qaGraph(), { query: "리액트로 한 프로젝트", limit: 2 }, { nowYear: QA_NOW_YEAR });
    expect(r.results).toHaveLength(2);
    expect(r.skills).toContain("React");
  });

  it("빈 그래프는 결과 없음", () => {
    expect(searchGraph(empty(), { query: "아무거나" }).results).toEqual([]);
  });
});

describe("graphText·체크리스트·스키마", () => {
  it("전체 텍스트와 상한", () => {
    const full = graphText(qaGraph());
    expect(full.text).toContain("[p_payment] 결제 개선");
    expect(full).toMatchObject({ nodeCount: 25, edgeCount: 29, chars: full.text.length });
    expect(graphText(qaGraph(), { maxChars: 1000 }).chars).toBeLessThanOrEqual(1000);
    expect(graphText(empty()).text).toBe(EMPTY_GRAPH_OVERVIEW);
  });

  it("체크리스트: 카테고리 이름과 프롬프트 텍스트", () => {
    const c = experienceChecklist(qaGraph());
    expect(c.categories).toHaveLength(10);
    expect(c.categories.find((x) => x.id === "leadership")).toMatchObject({ name: expect.any(String), required: expect.any(Boolean) });
    expect(c.text).toContain(`필수 ${c.requiredDone}/${c.requiredTotal}`);
  });

  it("스키마 문서", () => {
    const s = graphSchemaDocument();
    expect(s.personId).toBe("me");
    expect(s.labels.find((l) => l.label === "Role")?.props).toContain("current");
    expect(s.relations.find((r) => r.type === "AT_COMPANY")).toEqual({ type: "AT_COMPANY", name: "소속 회사", from: ["Role"], to: ["Company"] });
  });
});
