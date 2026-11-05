import { describe, expect, it } from "vitest";
import type { LlmClient } from "@/lib/llm/types";
import { FakeLlmClient } from "@/test/fake-llm";
import { qaGraph, QA_NOW_YEAR } from "./__fixtures__/qa-graph";
import {
  combineLlmRatings,
  detScore,
  llmRerank,
  MAX_PER_ANCHOR,
  rerank,
  scoreCandidates,
  shouldLlmRerank,
  SIGNAL_WEIGHTS,
  type Ranked,
} from "./rerank";
import { type Candidate, retrieve } from "./retrieve";

function cand(id: string, anchorId: string, signals: Partial<Candidate["signals"]>, label: Candidate["node"]["label"] = "Achievement"): Candidate {
  return {
    node: { id, label, props: { summary: id }, createdAt: 1, updatedAt: 1 } as Candidate["node"],
    name: id,
    signals: { lexical: 0, skill: 0, tag: 0, intent: 0, propagated: 0, metric: 0, recency: 0, centrality: 0, completeness: 0, ...signals },
    anchorId,
    path: [],
    seed: true,
    tokens: new Set([id]),
  };
}

const pipeline = (q: string) => {
  const r = retrieve(qaGraph(), q, { nowYear: QA_NOW_YEAR });
  return { r, ranked: rerank(r.candidates, r.query.intents, { fallback: r.fallback }) };
};

describe("결정적 점수", () => {
  it("가중치 합은 1이고, 모든 신호가 1이면 점수 1", () => {
    expect(Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    const all = Object.fromEntries(Object.keys(SIGNAL_WEIGHTS).map((k) => [k, 1])) as unknown as Candidate["signals"];
    expect(detScore(all)).toBeCloseTo(1);
  });

  it("lexical은 풀 최댓값으로 정규화한다", () => {
    const ranked = scoreCandidates([
      cand("a", "x", { lexical: 10 }),
      cand("b", "y", { lexical: 5 }),
      cand("c", "z", { lexical: 4 }),
      cand("d", "w", { lexical: 1 }),
    ]);
    expect(ranked.map((r) => r.candidate.node.id)).toEqual(["a", "b", "c"]); // d: 0.35·0.1 = 0.035 < 컷오프 0.08
    expect(ranked[0]!.det).toBeCloseTo(0.35);
    expect(ranked[1]!.det).toBeCloseTo(0.175);
  });

  it("컷오프 0.08: 남는 것이 3개 미만이면 상위 3개", () => {
    const low = [cand("a", "1", { recency: 1 }), cand("b", "2", { recency: 0.5 }), cand("c", "3", {}), cand("d", "4", {})];
    expect(scoreCandidates(low).map((r) => r.candidate.node.id)).toEqual(["a", "b", "c"]);
  });

  it("동점은 id 순 — 같은 입력이면 항상 같은 순서", () => {
    const xs = [cand("b", "1", { tag: 1 }), cand("a", "2", { tag: 1 }), cand("c", "3", { tag: 1 })];
    expect(rerank(xs, []).map((r) => r.candidate.node.id)).toEqual(["a", "b", "c"]);
    expect(rerank([...xs].reverse(), []).map((r) => r.candidate.node.id)).toEqual(["a", "b", "c"]);
  });
});

describe("MMR", () => {
  it(`같은 앵커에서는 ${MAX_PER_ANCHOR}개까지(나머지는 뒤로)`, () => {
    const same = ["a1", "a2", "a3", "a4", "a5"].map((id, i) => cand(id, "p1", { lexical: 10 - i, tag: 1 }, "Project"));
    const other = cand("b1", "p2", { lexical: 2, tag: 1 }, "Project");
    const ids = rerank([...same, other], []).map((r) => r.candidate.node.id);
    expect(ids.slice(0, 4).filter((id) => id.startsWith("a"))).toHaveLength(MAX_PER_ANCHOR);
    expect(ids.slice(0, 4)).toContain("b1");
  });

  it("성과 질문에서는 그 앵커의 성과를 하나 더 허용한다", () => {
    const same = ["a1", "a2", "a3", "a4", "a5"].map((id, i) => cand(id, "p1", { lexical: 10 - i, intent: 1 }));
    const ids = rerank(same, ["achievement"]).map((r) => r.candidate.node.id);
    expect(ids.slice(0, 4)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(ids[4]).toBe("a5");
  });

  it("성과 질문: 성과가 1위, 같은 프로젝트 성과가 상위 4에 3개를 넘지 않는다", () => {
    const top = pipeline("결제 개선 프로젝트 성과가 뭐였어?").ranked;
    expect(top[0]!.candidate.node.label).toBe("Achievement");
    const sameProjectAchievements = top.slice(0, 4).filter((r) => r.candidate.anchorId === "p_payment" && r.candidate.node.label === "Achievement");
    expect(sameProjectAchievements.length).toBeLessThanOrEqual(3);
  });
});

describe("LLM 리랭크(선택)", () => {
  const base = () => pipeline("결제 개선 프로젝트 성과가 뭐였어?").ranked;

  it("후보 밖 id는 무시하고 빠진 후보는 관련도 1, 관련도 0 + det<0.5는 버린다", () => {
    const ranked = base();
    const ratings = [
      { id: "c99", relevance: 3 },
      { id: "c2", relevance: 3 },
      { id: "c1", relevance: 0 },
      { id: "c4", relevance: 0 },
    ];
    const out = combineLlmRatings(ranked, ratings, ["achievement"]);
    const ids = out.map((r) => r.candidate.node.id);
    expect(ids[0]).toBe(ranked[1]!.candidate.node.id); // c2(관련도 3)이 1위로
    if (ranked[3]!.det < 0.5) expect(ids).not.toContain(ranked[3]!.candidate.node.id);
    expect(out.find((r) => r.candidate.node.id === ranked[2]!.candidate.node.id)!.llm).toBe(1); // 빠진 후보
    expect(out.every((r) => r.final >= 0 && r.final <= 1)).toBe(true);
  });

  it("가짜 LLM: 순서를 관련도로 바꿔 결합한다(used=true)", async () => {
    const ranked = base();
    const res = await llmRerank("결제 개선 프로젝트 성과가 뭐였어?", ranked, ["achievement"], new FakeLlmClient());
    expect(res.used).toBe(true);
    expect(res.ranked.length).toBeGreaterThan(0);
    expect(res.ranked.every((r) => r.llm !== undefined || ranked.indexOf(r) >= 20)).toBe(true);
  });

  it("LLM이 실패하면 결정적 순서 그대로(used=false, reason)", async () => {
    const ranked = base();
    const broken: LlmClient = {
      name: "broken",
      generate: async () => {
        throw new Error("엔진 오류");
      },
    };
    const res = await llmRerank("q", ranked, ["achievement"], broken);
    expect(res.used).toBe(false);
    expect(res.reason).toContain("엔진 오류");
    expect(res.ranked.map((r: Ranked) => r.candidate.node.id)).toEqual(ranked.map((r) => r.candidate.node.id));
  });

  it("실행 조건: 후보 > K, 꺼짐 플래그, CLI 엔진 기본 꺼짐, 남은 시간", () => {
    const ok = { poolSize: 20, k: 8, provider: "anthropic" as const, remainingMs: 200_000, env: {} };
    expect(shouldLlmRerank(ok).run).toBe(true);
    expect(shouldLlmRerank({ ...ok, poolSize: 8 }).run).toBe(false);
    expect(shouldLlmRerank({ ...ok, env: { GRAPH_QA_LLM_RERANK: "off" } }).run).toBe(false);
    expect(shouldLlmRerank({ ...ok, provider: "claude-cli" }).run).toBe(false);
    expect(shouldLlmRerank({ ...ok, provider: "claude-cli", env: { GRAPH_QA_LLM_RERANK: "on" } }).run).toBe(true);
    expect(shouldLlmRerank({ ...ok, remainingMs: 100_000 }).run).toBe(false);
  });
});
