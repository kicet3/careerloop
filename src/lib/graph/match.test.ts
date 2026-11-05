import { describe, expect, it } from "vitest";
import { type CareerGraph, edgeId, type GraphEdge, type GraphNode, type RelType } from "@/lib/domain/graph";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { aggregateSkillGap, graphChatPrompt, matchGraphToRequirements, requirementsFromJd, type SkillRequirement } from "./match";

const node = (id: string, label: GraphNode["label"], props: Record<string, unknown>): GraphNode =>
  ({ id, label, props, createdAt: 0, updatedAt: 0 }) as GraphNode;
const edge = (type: RelType, from: string, to: string): GraphEdge => ({ id: edgeId(type, from, to), type, from, to });

const graph: CareerGraph = {
  person: { id: "me", name: "홍길동" },
  nodes: [
    node("role1", "Role", { title: "프론트엔드 개발자" }),
    node("proj1", "Project", { name: "결제 화면 개편" }),
    node("sk-react", "Skill", { name: "리액트" }),
    node("sk-ts", "Skill", { name: "TypeScript" }),
    node("sk-go", "Skill", { name: "go" }),
    node("sk-figma", "Skill", { name: "Figma" }),
    node("ach1", "Achievement", { summary: "결제 전환율 개선", metric: "전환율", value: "12% → 18%" }),
  ],
  edges: [
    edge("USED_SKILL", "proj1", "sk-react"),
    edge("USED_SKILL", "role1", "sk-ts"),
    edge("HAS_SKILL", "me", "sk-react"),
    edge("HAS_SKILL", "me", "sk-go"),
    edge("ACHIEVED", "proj1", "ach1"),
    edge("WORKED_ON", "role1", "proj1"),
  ],
};

const req = (name: string, importance: SkillRequirement["importance"] = "must"): SkillRequirement => ({
  key: name,
  name,
  importance,
  evidence: null,
});

describe("matchGraphToRequirements", () => {
  it("증명됨·보유만·없음을 나누고, 증명한 경력의 성과를 붙인다", () => {
    const r = matchGraphToRequirements(graph, [req("React"), req("TypeScript"), req("Go", "nice"), req("Kubernetes"), req("Figma")]);
    const by = Object.fromEntries(r.items.map((i) => [i.name, i]));

    expect(by.React!.status).toBe("proven");
    expect(by.React!.skills).toEqual([{ id: "sk-react", name: "리액트" }]);
    expect(by.React!.provenBy).toEqual([{ id: "proj1", label: "Project", name: "결제 화면 개편" }]);
    expect(by.React!.achievements).toEqual([{ id: "ach1", summary: "결제 전환율 개선 (전환율 12% → 18%)", byId: "proj1" }]);

    expect(by.TypeScript!.status).toBe("proven");
    expect(by.TypeScript!.achievements).toEqual([]); // 직무에는 성과가 직접 이어지지 않았다

    expect(by.Go!.status).toBe("claimed"); // HAS_SKILL만
    expect(by.Figma!.status).toBe("claimed"); // 아무 관계 없는 Skill도 보유로 본다
    expect(by.Kubernetes!.status).toBe("missing");
    expect(r.summary).toEqual({ total: 5, proven: 2, claimed: 2, missing: 1 });
  });

  it("빈 그래프는 모두 없음", () => {
    const r = matchGraphToRequirements({ person: { id: "me", name: null }, nodes: [], edges: [] }, [req("React")]);
    expect(r.items[0]!.status).toBe("missing");
  });
});

const jd = (over: Partial<JdAnalysis> = {}): JdAnalysis => ({
  source: "jd",
  roleTitle: "프론트엔드 개발자",
  company: "페이랩",
  seniority: "주니어",
  summary: "",
  mustHave: [
    { id: "R1", text: "React·TypeScript 기반 개발 3년 이상", category: "skill", jdQuote: "React, TypeScript 3년 이상" },
    { id: "R2", text: "협업 경험", category: "soft", jdQuote: null },
  ],
  niceToHave: [{ id: "R3", text: "Next.js SSR 경험", category: "skill", jdQuote: null }],
  keywords: ["리액트", "GraphQL", "디자인 시스템 운영 경험", "Python과 Django", "x".repeat(41)],
  responsibilities: [],
  hiddenSignals: [],
  ...over,
});

describe("requirementsFromJd", () => {
  it("진단 JD 분석이 있으면 그것을 쓴다(필수 > 우대 > 키워드, 중복은 한 줄)", () => {
    const r = requirementsFromJd(jd(), "본문에는 Kubernetes만");
    expect(r.source).toBe("diagnosis");
    expect(r.requirements.map((x) => [x.name, x.importance])).toEqual([
      ["React", "must"],
      ["TypeScript", "must"],
      ["Next.js", "nice"],
      ["GraphQL", "keyword"],
      ["디자인 시스템", "keyword"],
      ["Python", "keyword"],
      ["Django", "keyword"],
    ]);
    expect(r.requirements[0]!.evidence).toBe("React, TypeScript 3년 이상");
  });

  it("사전에 없는 짧은 ATS 키워드는 원문 그대로 둔다", () => {
    const r = requirementsFromJd(jd({ mustHave: [], niceToHave: [], keywords: ["사내 정산 시스템"] }), null);
    expect(r.requirements).toEqual([{ key: "사내정산시스템", name: "사내 정산 시스템", importance: "keyword", evidence: null }]);
  });

  it("진단이 없으면 본문에서 사전으로 뽑고, 머리글로 필수·우대를 나눈다", () => {
    const text = [
      "페이랩은 Python 기반 결제 회사입니다.",
      "[자격 요건]",
      "- React 경험 3년 이상, 경력자 우대",
      "- TypeScript",
      "우대 사항",
      "- Next.js SSR 경험",
      "- React Native",
    ].join("\n");
    const r = requirementsFromJd(null, text);
    expect(r.source).toBe("keywords");
    expect(r.requirements.map((x) => [x.name, x.importance])).toEqual([
      ["React", "must"],
      ["TypeScript", "must"],
      ["Next.js", "nice"],
      ["React Native", "nice"],
      ["Python", "keyword"],
    ]);
    expect(r.requirements[0]!.evidence).toBe("- React 경험 3년 이상, 경력자 우대");
  });

  it("JD 없이 추정한 분석보다 지금 있는 본문을 우선한다", () => {
    expect(requirementsFromJd(jd({ source: "inferred" }), "Kubernetes 운영").requirements.map((x) => x.name)).toEqual(["Kubernetes"]);
    expect(requirementsFromJd(jd({ source: "inferred" }), "").source).toBe("diagnosis");
  });

  it("분석에서 기술을 못 찾으면 본문으로, 둘 다 없으면 none", () => {
    const empty = jd({ mustHave: [], niceToHave: [], keywords: [] });
    expect(requirementsFromJd(empty, "Docker 필수").source).toBe("keywords");
    expect(requirementsFromJd(empty, "")).toEqual({ source: "none", requirements: [] });
    expect(requirementsFromJd(null, "함께 성장할 분을 찾습니다")).toEqual({ source: "none", requirements: [] });
  });
});

describe("aggregateSkillGap", () => {
  const row = (postingId: string, items: [string, SkillRequirement["importance"], "proven" | "claimed" | "missing"][]) => ({
    postingId,
    company: `회사${postingId}`,
    roleTitle: "개발자",
    items: items.map(([name, importance, status]) => ({ key: name, name, importance, status })),
  });

  it("없음만 공고 수 → 필수 수 → 이름 순으로 센다", () => {
    const gaps = aggregateSkillGap([
      row("1", [["Kubernetes", "keyword", "missing"], ["AWS", "must", "missing"], ["React", "must", "proven"]]),
      row("2", [["Kubernetes", "must", "missing"], ["AWS", "must", "missing"], ["Kafka", "nice", "missing"]]),
      row("3", [["Kubernetes", "nice", "missing"], ["React", "must", "claimed"], ["Docker", "nice", "missing"]]),
      row("4", [["Kubernetes", "must", "missing"], ["Kubernetes", "must", "missing"]]),
    ]);
    expect(gaps.map((g) => [g.name, g.postings, g.mustCount])).toEqual([
      ["Kubernetes", 4, 2],
      ["AWS", 2, 2],
      ["Docker", 1, 0],
      ["Kafka", 1, 0],
    ]);
    expect(gaps[0]!.examples.map((e) => e.postingId)).toEqual(["1", "2", "3"]);
  });

  it("limit을 지킨다", () => {
    expect(aggregateSkillGap([row("1", [["A", "must", "missing"], ["B", "must", "missing"]])], 1)).toHaveLength(1);
  });
});

it("graphChatPrompt는 기술과 공고를 담는다", () => {
  expect(graphChatPrompt("Kubernetes", { company: "페이랩", roleTitle: "백엔드" })).toContain("'Kubernetes' (페이랩 · 백엔드 공고에서 요구)");
});
