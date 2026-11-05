import { describe, expect, it } from "vitest";
import { type CareerGraph, edgeId, type GraphNode } from "@/lib/domain/graph";
import { qaGraph, QA_NOW_YEAR } from "./__fixtures__/qa-graph";
import { analyzeQuery, hangulBigrams, recencyOf, retrieve, stripParticle, tokenize } from "./retrieve";

const n = (id: string, label: GraphNode["label"], props: Record<string, unknown>): GraphNode =>
  ({ id, label, props, createdAt: 1, updatedAt: 1 }) as GraphNode;

describe("질문 분석", () => {
  it("조사·어미를 하나 떼고(어간 2글자 이상), 불용어를 뺀다", () => {
    expect(stripParticle("페이랩에서")).toBe("페이랩");
    expect(stripParticle("리액트로")).toBe("리액트");
    expect(stripParticle("성과")).toBe("성과"); // '과'를 떼면 1글자라 그대로
    expect(stripParticle("react로")).toBe("react");
    expect(tokenize("결제 시스템을 6시간에서 40분으로")).toEqual(["결제", "시스템", "6시간", "40분"]);
    expect([...analyzeQuery("내가 했던 리더십 경험 알려줘").terms.keys()]).toEqual(["리더십"]);
  });

  it("3글자 이상 한글 토큰은 글자 바이그램(가중치 0.5)을 따로 만든다", () => {
    expect(hangulBigrams("결제개선")).toEqual(["결제", "제개", "개선"]);
    expect(hangulBigrams("결제")).toEqual([]);
    const q = analyzeQuery("결제개선 성과");
    expect(q.bigrams.get("개선")).toBe(0.5);
  });

  it("기술 별칭을 정식 명칭으로(리액트 → React), 정식 이름도 용어로 넣는다", () => {
    const q = analyzeQuery("리액트랑 자바스크립트 써 봤어?");
    expect(q.skills).toEqual(expect.arrayContaining(["React", "JavaScript"]));
    expect(q.terms.has("react")).toBe(true);
    expect(q.intents).toContain("skill");
  });

  it("소재 태그·의도·연도", () => {
    expect(analyzeQuery("리더십 경험").tags).toEqual(["leadership"]);
    expect(analyzeQuery("협업·갈등 해결 경험").tags).toContain("collaboration");
    expect(analyzeQuery("결제 개선 프로젝트 성과").intents).toEqual(["achievement"]); // 대상 의도가 있으면 project는 뺀다
    expect(analyzeQuery("결제 개선 프로젝트 성과").tags).toEqual([]); // '개선'은 태그로 보지 않는다
    expect(analyzeQuery("자격증이랑 토익 점수").intents).toContain("certification");
    expect(analyzeQuery("2022년에 한 프로젝트").years).toEqual([2022]);
    expect(analyzeQuery("자기소개용으로 전체 정리").intents).toContain("overview");
  });

  it("이전 질문 용어는 0.3배로 섞는다(지시어 질문)", () => {
    const q = analyzeQuery("그 프로젝트 성과는?", { history: "결제 개선 프로젝트 알려줘" });
    expect(q.terms.get("성과")).toBe(1);
    expect(q.terms.get("결제")).toBeCloseTo(0.3);
    expect(q.intents).toEqual(["achievement"]); // 의도는 이번 질문만
  });
});

describe("후보 생성·확장", () => {
  it("BM25F: 대표 이름에 맞은 노드가 설명에만 맞은 노드보다 높다", () => {
    const g: CareerGraph = {
      person: { id: "me", name: null },
      nodes: [n("p1", "Project", { name: "검색 개선" }), n("p2", "Project", { name: "다른 일", summary: "검색 화면도 조금 고쳤다" }), n("p3", "Project", { name: "무관" })],
      edges: [],
    };
    const r = retrieve(g, "검색", { nowYear: 2026 });
    const lex = new Map(r.candidates.map((c) => [c.node.id, c.signals.lexical]));
    expect(lex.get("p1")!).toBeGreaterThan(lex.get("p2")!);
    expect(lex.has("p3")).toBe(false);
  });

  it("한글 접두 일치: '개선' 질문이 '개선했다' 본문과 맞는다", () => {
    const g: CareerGraph = { person: { id: "me", name: null }, nodes: [n("p1", "Project", { name: "X", result: "속도를 개선했다" })], edges: [] };
    expect(retrieve(g, "개선").candidates[0]?.signals.lexical).toBeGreaterThan(0);
  });

  it("기술 신호: 일치하는 Skill 1, 그 기술을 USED_SKILL로 쓴 노드 0.7", () => {
    const r = retrieve(qaGraph(), "리액트", { nowYear: QA_NOW_YEAR });
    const sig = new Map(r.candidates.map((c) => [c.node.id, c.signals.skill]));
    expect(sig.get("s_react")).toBe(1);
    expect(sig.get("p_dashboard")).toBe(0.7);
    expect(sig.get("p_shop")).toBe(0.7);
  });

  it("성과 질문: 시드 프로젝트의 ACHIEVED 자식을 0.8로 전파한다", () => {
    const r = retrieve(qaGraph(), "결제 개선 성과", { nowYear: QA_NOW_YEAR });
    const fail = r.candidates.find((c) => c.node.id === "a_fail")!;
    expect(fail.signals.propagated).toBeGreaterThanOrEqual(0.7);
    expect(fail.path.map((s) => s.id)).toEqual(["me", "c_paylab", "r_backend", "p_payment", "a_fail"]);
    expect(fail.anchorId).toBe("p_payment");
  });

  it("빈 그래프는 후보가 없다, 풀은 POOL_MAX 이하", () => {
    expect(retrieve({ person: { id: "me", name: null }, nodes: [], edges: [] }, "아무거나").candidates).toEqual([]);
    const nodes = Array.from({ length: 80 }, (_, i) => n(`s${i}`, "Skill", { name: `기술${i} 검색` }));
    const g: CareerGraph = { person: { id: "me", name: null }, nodes, edges: nodes.map((x) => ({ id: edgeId("HAS_SKILL", "me", x.id), type: "HAS_SKILL" as const, from: "me", to: x.id })) };
    expect(retrieve(g, "검색").candidates.length).toBe(60);
  });

  it("최근성: 현재 1, 오래될수록 감쇠, 질문 연도와 겹치면 1", () => {
    expect(recencyOf(n("r", "Role", { title: "x", current: true }), [], 2026)).toBe(1);
    const old = recencyOf(n("p", "Project", { name: "x", endDate: "2018-01" }), [], 2026);
    const recent = recencyOf(n("p", "Project", { name: "x", endDate: "2025-01" }), [], 2026);
    expect(recent).toBeGreaterThan(old);
    expect(recencyOf(n("p", "Project", { name: "x", startDate: "2021-01", endDate: "2023-01" }), [2022], 2026)).toBe(1);
  });
});
