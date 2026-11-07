import { describe, expect, it, vi } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { graphA } from "./__fixtures__/agent-graph";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/graph/service", () => ({ getCareerGraph: async () => ({ person: { id: "me", name: null }, nodes: [], edges: [] }) }));

const { buildEvidencePack, evidenceLine, expandPack, requirementSignals, PACK_MAX_CHARS } = await import("./evidence");

const req = (id: string, text: string) => ({ id, text, category: "skill" as const, jdQuote: text });
const JD: JdAnalysis = {
  source: "jd",
  roleTitle: "백엔드 개발자",
  company: null,
  seniority: "",
  summary: "",
  mustHave: [req("R1", "Kafka 이벤트 파이프라인 운영 경험"), req("R2", "Redis 캐시 설계 경험")],
  niceToHave: [req("R3", "Terraform 인프라 자동화")],
  keywords: ["Kafka", "Redis", "Terraform", "Kotlin"],
  responsibilities: ["주문 서버 개발"],
  hiddenSignals: [],
};

describe("requirementSignals", () => {
  it("필수·우대 요건은 모두, 요건에 안 묶인 키워드·업무를 덧붙인다", () => {
    const s = requirementSignals(JD);
    expect(s.filter((x) => x.kind === "must").map((x) => x.id)).toEqual(["R1", "R2"]);
    expect(s.find((x) => x.id === "R1")!.query).toContain("Kafka");
    expect(s.filter((x) => x.kind === "keyword").map((x) => x.text)).toEqual(["Kotlin"]);
    expect(s.some((x) => x.kind === "responsibility")).toBe(true);
  });
});

describe("buildEvidencePack", () => {
  const signals = requirementSignals(JD);
  const { pack, warnings, insufficient } = buildEvidencePack(graphA(), JD, signals, "", { nowYear: 2026 });
  const byNode = new Map(pack.items.map((i) => [i.nodeId, i]));
  const refsOf = (id: string) => pack.byRequirement.find((b) => b.requirementId === id)!.refs.map((r) => pack.items.find((i) => i.ref === r)!.nodeId);

  it("요건마다 직접 맞은 근거가 위로: Kafka → 주문 시스템 개편, Redis → 상품 캐시 개편", () => {
    expect(refsOf("R1")).toContain("p1");
    expect(refsOf("R1")).not.toContain("p2");
    expect(refsOf("R2")).toContain("p2");
    expect(refsOf("R2").indexOf("p2")).toBeLessThan(Math.max(0, refsOf("R2").indexOf("p1")) || 99);
  });

  it("근거가 없는 요건은 비어 있고 커버리지에 반영된다", () => {
    expect(refsOf("R3")).toEqual([]);
    expect(pack.coverage).toEqual({ mustFound: 2, mustTotal: 2, niceFound: 0, niceTotal: 1 });
    expect(pack.byRequirement.find((b) => b.requirementId === "R1")!.skillStatus).toBe("proven");
    expect(insufficient).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("경력 뼈대는 늘 포함, Person은 없음, ref는 E1부터 연속, 직무에는 소속 회사·기간", () => {
    for (const id of ["c1", "r1", "e1"]) expect(byNode.has(id)).toBe(true);
    expect(pack.items.map((i) => i.ref)).toEqual(pack.items.map((_, i) => `E${i + 1}`));
    expect(pack.items.some((i) => (i.label as string) === "Person")).toBe(false);
    expect(byNode.get("r1")!.facts).toEqual({ company: "페이랩", startDate: "2021.03", endDate: "", current: true });
    expect(evidenceLine(byNode.get("p1")!)).toMatch(/^E\d+ \[프로젝트\] 주문 시스템 개편 \(나 → 페이랩\(회사\) → 백엔드 개발자\(직무\) → 주문 시스템 개편\(프로젝트\)\) 2022\.01 ~ 2022\.12 \| /);
    expect(JSON.stringify(pack)).not.toContain('"me"');
  });

  it("결정적: 같은 입력이면 같은 pack", () => {
    expect(buildEvidencePack(graphA(), JD, signals, "", { nowYear: 2026 }).pack).toEqual(pack);
  });

  it("글자 상한을 넘으면 속성을 줄이고 뒤 순위부터 자른다", () => {
    const big: CareerGraph = graphA();
    for (let i = 0; i < 120; i++) {
      big.nodes.push({ id: `px${i}`, label: "Project", props: { name: `큰 프로젝트 ${i}`, situation: "가".repeat(900), action: "Kafka 운영 ".repeat(130), result: "나".repeat(900) }, createdAt: 1, updatedAt: 1 });
      big.edges.push({ id: `WORKED_ON:r1:px${i}`, type: "WORKED_ON", from: "r1", to: `px${i}` });
    }
    const r = buildEvidencePack(big, JD, signals, "", { nowYear: 2026 });
    expect(r.pack.items.length).toBeLessThanOrEqual(80);
    expect(r.pack.items.reduce((n, it) => n + evidenceLine(it).length + 1, 0)).toBeLessThanOrEqual(PACK_MAX_CHARS);
    expect(r.pack.items.some((i) => i.text.includes("…(잘림)"))).toBe(true);
    // 필수 요건 근거와 경력 뼈대는 남는다.
    expect(r.pack.items.some((i) => i.nodeId === "r1")).toBe(true);
    expect(r.pack.byRequirement.find((b) => b.requirementId === "R1")!.refs.length).toBeGreaterThan(0);
  });

  it("경력이 하나도 없으면 insufficient(그래프 부족)", () => {
    const g: CareerGraph = { person: { id: "me", name: null }, nodes: [{ id: "s", label: "Skill", props: { name: "Excel" }, createdAt: 1, updatedAt: 1 }], edges: [] };
    expect(buildEvidencePack(g, JD, signals, "", { nowYear: 2026 }).insufficient).toBe(true);
  });
});

describe("expandPack", () => {
  it("새 노드는 기존 번호 뒤에 붙이고(기존 ref 유지) version을 올린다, 못 찾은 요건은 unresolved", () => {
    const g = graphA();
    const gone = new Set(["p2", "s_redis", "s_aws"]);
    const without = { ...g, nodes: g.nodes.filter((n) => !gone.has(n.id)), edges: g.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)) };
    const small = buildEvidencePack(without, JD, requirementSignals(JD), "", { nowYear: 2026 }).pack;
    const before = small.items.map((i) => [i.ref, i.nodeId]);
    const r = expandPack(g, small, [{ requirementId: "R2", query: "Redis 캐시 설계 경험" }, { requirementId: "R3", query: "Terraform" }], { nowYear: 2026 });
    expect(r.pack.items.slice(0, before.length).map((i) => [i.ref, i.nodeId])).toEqual(before);
    expect(r.added).toBeGreaterThan(0);
    expect(r.pack.items.slice(before.length).map((i) => i.nodeId)).toContain("p2");
    expect(r.pack.version).toBe(2);
    expect(r.unresolved).toEqual(["R3"]);
    expect(r.graphChanged).toBe(true);
  });
});
