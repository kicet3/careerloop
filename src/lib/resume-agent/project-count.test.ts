/**
 * 대표 프로젝트 2~3개 기준(resumes/project-count.ts)이 생성 경로마다 적용되는지: 프롬프트 문구·작전 보정(balanceProjects)·
 * 분량(clampBudgets·trimToBudget)·구역 후보 수·총괄 피드백(routeProjectShortfall). 근거에 없는 프로젝트를 지어 채우지 않는다.
 */
import { describe, expect, it, vi } from "vitest";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { EMPTY_RESUME_ITEM, emptyResumeDocument } from "@/lib/domain/resumes";
import { checkProjectCount, PROJECT_COUNT_RULE, PROJECT_MORE_QUESTION } from "@/lib/resumes/project-count";
import { buildPlanPrompt, AGENT_SYSTEM } from "./prompts";
import { buildBriefPrompt } from "./prompts-v2";
import type { EvidenceItem, EvidencePack, ResumeAgentPlan } from "./schemas";
import { projectsAgent } from "./sections/agents";
import { projectCandidateCount, trimToBudget } from "./sections/common";
import { clampBudgets, DEFAULT_BUDGETS } from "./steps/brief";
import { balanceProjects } from "./steps/plan";
import { routeProjectShortfall } from "./steps/critique";

vi.mock("server-only", () => ({}));

const item = (ref: string, label: EvidenceItem["label"], name: string): EvidenceItem => ({
  ref,
  nodeId: `n_${ref}`,
  label,
  name,
  path: `나 → ${name}`,
  text: `${name} 설명`,
  period: "",
  skills: [],
  hasMetric: false,
  completeness: 1,
  facts: null,
});

function packOf(items: EvidenceItem[], byRequirement: EvidencePack["byRequirement"] = []): EvidencePack {
  return { version: 1, graphFingerprint: "f", items, byRequirement, coverage: { mustFound: 0, mustTotal: 0, niceFound: 0, niceTotal: 0 }, truncated: false, skillKeys: [] };
}

function planOf(projects: string[], exclude: string[] = []): ResumeAgentPlan {
  return {
    positioning: "",
    headline: "",
    requirementMap: [],
    include: { experience: [], projects: projects.map((ref) => ({ ref, why: "", requirementIds: [] })), extras: [] },
    exclude: exclude.map((ref) => ({ ref, reason: "무관" })),
    keywordPlan: [],
    sectionEmphasis: [],
    gapQuestions: [],
  };
}

const project = (name: string, bullets: string[] = [`${name} 결과`]) => ({ ...EMPTY_RESUME_ITEM.project(), name, bullets });

describe("checkProjectCount", () => {
  it("3개 초과는 앞의 3개만 남기고 뺀 이름을 알린다", () => {
    const r = checkProjectCount([{ name: "A" }, { name: "B" }, { name: "C" }, { name: " " }], 4);
    expect(r.keep).toBe(3);
    expect(r.notes[0]).toContain("(이름 없음)");
    expect(r.missingInfo).toEqual([]);
  });
  it("2~3개면 그대로", () => {
    expect(checkProjectCount([{ name: "A" }, { name: "B" }], 5)).toEqual({ keep: 2, notes: [], missingInfo: [] });
  });
  it("2개 미만이면 질문을 남기고, 자료에 더 있으면 안내한다(지어 채우지 않는다)", () => {
    expect(checkProjectCount([{ name: "A" }], 3)).toMatchObject({ keep: 1, missingInfo: [PROJECT_MORE_QUESTION] });
    expect(checkProjectCount([{ name: "A" }], 3).notes[0]).toContain("프로젝트가 3개");
    expect(checkProjectCount([{ name: "A" }], 1).notes).toEqual([]);
    expect(checkProjectCount([], null)).toEqual({ keep: 0, notes: [], missingInfo: [PROJECT_MORE_QUESTION] });
  });
});

describe("프롬프트 문구", () => {
  const jd: JdAnalysis = {
    source: "posting",
    roleTitle: "백엔드",
    seniority: "",
    summary: "",
    mustHave: [],
    niceToHave: [],
    keywords: [],
    responsibilities: [],
    hiddenSignals: [],
  } as unknown as JdAnalysis;
  const ctx = { company: "c", roleTitle: "r", templateId: "performance" as const };

  it("v1 에이전트 규칙·계획·양식 메모가 2~3개", () => {
    expect(AGENT_SYSTEM).toContain(`A7. ${PROJECT_COUNT_RULE}`);
    const { user } = buildPlanPrompt(ctx, jd, packOf([]));
    expect(user).toContain("대표 프로젝트 2~3개");
    expect(user).not.toContain("2~4개");
    expect(user).toContain("프로젝트는 대표 2~3개를");
  });

  it("v2 총괄 작전과 프로젝트 구역 규칙이 2~3개", () => {
    const { user } = buildBriefPrompt(ctx, jd, packOf([]), { pageTarget: 1, budgets: DEFAULT_BUDGETS[1], company: true });
    expect(user).toContain("대표 프로젝트(projects)는 쪽수와 관계없이 기본 2~3개");
    expect(user).toContain("projects(대표 프로젝트): 항목 3");
    expect(projectsAgent.rules.join("\n")).toContain("대표 프로젝트는 기본 2~3개");
    expect(projectsAgent.rules.join("\n")).toContain("지어내지 말고");
  });
});

describe("balanceProjects(작전 보정)", () => {
  const reqs = new Set(["R1", "R2"]);

  it("3개가 넘으면 앞의 3개만(중복 ref는 하나로)", () => {
    const plan = planOf(["E1", "E2", "E2", "E3", "E4"]);
    const warnings: string[] = [];
    balanceProjects(plan, undefined, reqs, warnings);
    expect(plan.include.projects.map((p) => p.ref)).toEqual(["E1", "E2", "E3"]);
    expect(warnings).toHaveLength(1);
  });

  it("2개 미만이면 근거의 프로젝트를 JD 요건 연결이 많은 순으로 더한다 — 뺀 것·명시적으로 뺀 것·다른 라벨은 제외", () => {
    const pack = packOf(
      [item("E1", "Project", "주문"), item("E2", "Project", "캐시"), item("E3", "Project", "검색"), item("E4", "Project", "무관"), item("E5", "Achievement", "성과"), item("E6", "Project", "제외됨")],
      [
        { requirementId: "R1", refs: ["E1", "E3"], skillStatus: "proven", topScore: 1 },
        { requirementId: "R2", refs: ["E3"], skillStatus: "proven", topScore: 1 },
      ],
    );
    const plan = planOf(["E1"], ["E4"]);
    const warnings: string[] = [];
    balanceProjects(plan, pack, reqs, warnings, new Set(["E6"]));
    expect(plan.include.projects.map((p) => p.ref)).toEqual(["E1", "E3"]);
    expect(plan.include.projects[1]!.requirementIds).toEqual(["R1", "R2"]);
    expect(warnings[0]).toContain("E3");
  });

  it("근거에 프로젝트가 1개뿐이면 그대로 둔다(지어내지 않는다)", () => {
    const plan = planOf(["E1"]);
    balanceProjects(plan, packOf([item("E1", "Project", "주문"), item("E2", "Role", "개발자")]), reqs, []);
    expect(plan.include.projects.map((p) => p.ref)).toEqual(["E1"]);
  });
});

describe("분량", () => {
  it("프로젝트 항목 예산은 쪽수와 관계없이 2~3개로 묶인다", () => {
    expect(DEFAULT_BUDGETS[1].projects.items).toBe(3);
    expect(DEFAULT_BUDGETS[2].projects.items).toBe(3);
    expect(clampBudgets({ projects: { items: 1, linesPerItem: 3, chars: 600 } }, 1).projects.items).toBe(2);
    expect(clampBudgets({ projects: { items: 3, linesPerItem: 3, chars: 600 } }, 2).projects.items).toBe(3);
  });

  it("글자 수 자르기는 프로젝트를 2개 아래로 줄이지 않는다(항목 상한 3은 지킨다)", () => {
    const projects = [project("A", ["a".repeat(200)]), project("B", ["b".repeat(200)]), project("C", ["c".repeat(200)]), project("D", ["d".repeat(200)])];
    const citations = projects.map((_, i) => ({ path: `projects[${i}]`, refs: [`E${i + 1}`], requirementIds: [] }));
    const t = trimToBudget("projects", { projects }, citations, { items: 3, linesPerItem: 3, chars: 50 }, []);
    expect(t.fragment.projects!.map((p) => p.name)).toEqual(["A", "B"]);
    expect(t.citations.map((c) => c.path)).toEqual(["projects[0]", "projects[1]"]);
  });
});

describe("총괄 피드백: 대표 프로젝트 부족", () => {
  const brief = { include: { experience: [], projects: [{ ref: "E1", why: "", requirementIds: [] }], extras: [] }, exclude: [{ ref: "E9", reason: "무관" }] };

  it("근거에 프로젝트가 2개 이상인데 문서에 1개면 projects 구역에 다시 쓰기를 건다(후보 = 인용하지 않은 프로젝트)", () => {
    const pack = packOf([item("E1", "Project", "주문"), item("E2", "Project", "캐시"), item("E9", "Project", "무관")]);
    expect(projectCandidateCount(pack, brief)).toBe(2);
    const routed = new Map();
    const doc = { ...emptyResumeDocument(), projects: [project("주문")] };
    expect(routeProjectShortfall(routed, { document: doc, citations: [{ path: "projects[0]", refs: ["E1"], requirementIds: [] }] }, pack, brief)).toBe(true);
    const r = routed.get("projects");
    expect(r.severe).toBe(true);
    expect(r.texts[0]).toContain("후보: E2");
    expect(r.texts[0]).not.toContain("E9");
  });

  it("근거에 프로젝트가 1개뿐이거나 이미 2개 이상이면 아무것도 하지 않는다", () => {
    const one = packOf([item("E1", "Project", "주문"), item("E9", "Project", "무관")]);
    const doc1 = { ...emptyResumeDocument(), projects: [project("주문")] };
    expect(routeProjectShortfall(new Map(), { document: doc1, citations: [] }, one, brief)).toBe(false);
    const two = packOf([item("E1", "Project", "주문"), item("E2", "Project", "캐시")]);
    const doc2 = { ...emptyResumeDocument(), projects: [project("주문"), project("캐시")] };
    expect(routeProjectShortfall(new Map(), { document: doc2, citations: [] }, two, brief)).toBe(false);
  });

  it("근거의 프로젝트를 이미 모두 인용했으면 다시 쓰기를 걸지 않는다(늘릴 근거가 없다)", () => {
    const pack = packOf([item("E1", "Project", "주문"), item("E2", "Project", "캐시")]);
    const doc = { ...emptyResumeDocument(), projects: [project("주문·캐시")] };
    const routed = new Map();
    expect(routeProjectShortfall(routed, { document: doc, citations: [{ path: "projects[0]", refs: ["E1", "E2"], requirementIds: [] }] }, pack, brief)).toBe(false);
    expect(routed.has("projects")).toBe(false);
  });
});
