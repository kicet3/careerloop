/**
 * 그래프에 묻기 검색·리랭크 골든 셋(docs/GRAPH-QA.md 평가 계획). 고정 그래프(__fixtures__/qa-graph.ts)에 한국어 질문을 던져
 * 결정적 파이프라인(retrieve → rerank)의 상위 노드를 본다. 가중치를 바꾸면 이 테스트가 회귀를 잡는다.
 * 기준선: 1위 정확도 ≥ 80%, recall@3 = 100%.
 */
import { describe, expect, it } from "vitest";
import { qaGraph, QA_NOW_YEAR } from "./__fixtures__/qa-graph";
import { answerK, rerank } from "./rerank";
import { retrieve } from "./retrieve";

interface Golden {
  q: string;
  history?: string;
  /** 1위로 인정하는 노드. */
  top1: string[];
  /** 상위 3 안에 모두 있어야 하는 노드. */
  inTop3: string[];
}

const GOLDEN: Golden[] = [
  { q: "결제 개선 프로젝트 성과가 뭐였어?", top1: ["a_settle"], inTop3: ["a_settle", "p_payment"] },
  { q: "리액트로 뭘 만들었지?", top1: ["s_react", "p_shop", "p_dashboard"], inTop3: ["p_shop", "p_dashboard"] },
  { q: "리더십 경험 알려줘", top1: ["e_club"], inTop3: ["e_club"] },
  { q: "페이랩에서 무슨 일 했어?", top1: ["c_paylab", "r_backend"], inTop3: ["c_paylab", "r_backend"] },
  { q: "자격증 뭐 있어?", top1: ["cert_eip"], inTop3: ["cert_eip"] },
  { q: "수치로 보여줄 성과", top1: ["a_settle", "a_fail", "a_dash", "a_cvr"], inTop3: [] },
  { q: "2022년에 한 프로젝트", top1: ["p_dashboard"], inTop3: ["p_dashboard"] },
  { q: "협업하면서 갈등 해결한 적", top1: ["e_hackathon"], inTop3: ["e_hackathon"] },
  { q: "전공이 뭐야", top1: ["ed_univ"], inTop3: ["ed_univ"] },
  { q: "그 프로젝트 성과는?", history: "결제 개선 프로젝트 알려줘", top1: ["a_settle", "a_fail"], inTop3: ["p_payment"] },
  { q: "Kafka 써 본 적 있어?", top1: ["s_kafka", "p_payment"], inTop3: ["s_kafka", "p_payment"] },
  { q: "파이썬으로 공부한 것", top1: ["p_wiki"], inTop3: ["p_wiki", "s_python"] },
];

function ranked(q: string, history?: string) {
  const r = retrieve(qaGraph(), q, { nowYear: QA_NOW_YEAR, history });
  return { r, top: rerank(r.candidates, r.query.intents, { fallback: r.fallback }).slice(0, answerK(r.query.intents)) };
}

describe("골든 셋", () => {
  for (const g of GOLDEN) {
    it(`${g.q} → ${g.top1.join("|")}`, () => {
      const ids = ranked(g.q, g.history).top.map((x) => x.candidate.node.id);
      expect(g.top1).toContain(ids[0]);
      for (const id of g.inTop3) expect(ids.slice(0, 3)).toContain(id);
    });
  }

  it("집계: 1위 정확도 ≥ 80%, recall@3 = 100%, MRR ≥ 0.9", () => {
    let hit1 = 0;
    let recall = 0;
    let total = 0;
    let rr = 0;
    for (const g of GOLDEN) {
      const ids = ranked(g.q, g.history).top.map((x) => x.candidate.node.id);
      if (g.top1.includes(ids[0]!)) hit1++;
      const rank = ids.findIndex((id) => g.top1.includes(id));
      rr += rank >= 0 ? 1 / (rank + 1) : 0;
      for (const id of g.inTop3) {
        total++;
        if (ids.slice(0, 3).includes(id)) recall++;
      }
    }
    expect(hit1 / GOLDEN.length).toBeGreaterThanOrEqual(0.8);
    expect(recall / total).toBe(1);
    expect(rr / GOLDEN.length).toBeGreaterThanOrEqual(0.9);
  });

  it("리액트 질문: 리액트(별칭)가 React로 정규화되고, React를 쓴 프로젝트가 상위 2 안에 있다", () => {
    const { r, top } = ranked("리액트로 뭘 만들었지?");
    expect(r.query.skills).toContain("React");
    const ids = top.map((x) => x.candidate.node.id);
    expect(ids.slice(0, 2).some((id) => id === "p_shop" || id === "p_dashboard")).toBe(true);
  });

  it("수치 성과 질문: 상위 3은 모두 수치 있는 성과이고, 서로 다른 프로젝트에서 2개 이상(MMR)", () => {
    const top3 = ranked("수치로 보여줄 성과").top.slice(0, 3);
    expect(top3.every((x) => x.candidate.node.label === "Achievement" && x.candidate.signals.metric === 1)).toBe(true);
    expect(new Set(top3.map((x) => x.candidate.anchorId)).size).toBeGreaterThanOrEqual(2);
  });

  it("그래프에 없는 주제(우주항공): 시드가 없어 층화 폴백", () => {
    const { r, top } = ranked("우주항공 경험");
    expect(r.fallback).toBe(true);
    expect(top.length).toBeGreaterThan(0);
  });

  it("개요 질문: 컷오프 없이 K=12까지, 여러 라벨이 섞인다", () => {
    const { top } = ranked("자기소개용으로 전체 정리해줘");
    expect(top.length).toBe(12);
    expect(new Set(top.map((x) => x.candidate.node.label)).size).toBeGreaterThanOrEqual(5);
  });
});
