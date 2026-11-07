import { describe, expect, it } from "vitest";
import {
  countPortfolioAddMarkers,
  defaultProjectSelection,
  graphPortfolioStepStates,
  graphPortfolioToMarkdown,
  parseGraphPortfolioSource,
  portfolioOpenItems,
  StartGraphPortfolioSchema,
  type GraphPortfolioOutput,
  type GraphProjectOption,
} from "./graph-portfolio";

const output = (over: Partial<GraphPortfolioOutput> = {}): GraphPortfolioOutput => ({
  headline: "정산을 빠르게 만드는 백엔드 개발자",
  intro: "결제·정산 도메인에서 일했습니다.",
  coreSkills: ["Kotlin", " Spring "],
  projects: [
    {
      projectId: "p1",
      name: "정산 개편",
      oneLiner: "정산 배치를 다시 만들었다",
      overview: "하루 정산이 6시간 걸렸다.",
      period: "2024.01 ~ 2024.06",
      affiliation: "페이랩",
      role: "백엔드 리드",
      techStack: ["Kotlin", "a`b"],
      star: { situation: "정산 지연", task: "", action: ["청크 처리로 바꿈", "인덱스 추가"], result: "6시간→40분" },
      outcomes: ["정산 시간 6시간→40분", " "],
      learned: "",
    },
  ],
  notes: [],
  missingInfo: [],
  ...over,
});

describe("graphPortfolioToMarkdown", () => {
  it("프로젝트마다 개요·역할·기술·문제·해결(STAR)·성과·링크, 빈 칸은 쓰지 않는다", () => {
    const md = graphPortfolioToMarkdown(output(), {
      title: "백엔드 포트폴리오",
      personName: "홍길동",
      links: new Map([["p1", [{ label: "GitHub · u/[pay]", url: "https://github.com/u/pay" }]]]),
    });
    expect(md.startsWith("# 백엔드 포트폴리오\n")).toBe(true);
    expect(md).toContain("**홍길동**");
    expect(md).toContain("> 정산을 빠르게 만드는 백엔드 개발자");
    expect(md).toContain("**핵심 기술** · Kotlin · Spring");
    expect(md).toContain("## 1. 정산 개편");
    expect(md).toContain("2024.01 ~ 2024.06 · 페이랩");
    expect(md).toContain("### 기술 스택\n\n`Kotlin` `ab`");
    expect(md).toContain("- **행동(A)**\n  - 청크 처리로 바꿈\n  - 인덱스 추가");
    expect(md).not.toContain("과제(T)");
    expect(md).toContain("### 성과\n\n- 정산 시간 6시간→40분\n");
    expect(md).not.toContain("배운 점");
    expect(md).toContain("- [GitHub · u/pay](https://github.com/u/pay)");
  });

  it("링크가 없으면 링크 구역이 없다", () => {
    expect(graphPortfolioToMarkdown(output(), { title: "" })).not.toContain("### 링크");
    expect(graphPortfolioToMarkdown(output(), { title: "" }).startsWith("# 포트폴리오")).toBe(true);
  });
});

describe("시작 입력·생성 정보", () => {
  it("StartGraphPortfolioSchema: 프로젝트 1~12개, 중복 제거", () => {
    expect(StartGraphPortfolioSchema.parse({ projectIds: ["a", "a", "b"] }).projectIds).toEqual(["a", "b"]);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: [] }).success).toBe(false);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: Array.from({ length: 13 }, (_, i) => `p${i}`) }).success).toBe(false);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: ["a"], notes: "x".repeat(1001) }).success).toBe(false);
  });

  it("parseGraphPortfolioSource: 틀린 칸은 기본값, 객체가 아니면 null", () => {
    expect(parseGraphPortfolioSource(null)).toBeNull();
    expect(parseGraphPortfolioSource({ projectIds: ["p1"], postingId: 3 })).toEqual({ projectIds: ["p1"], postingId: null, notes: "", missingInfo: [], generatedAt: 0, addMarkers: null });
  });

  it("채워야 할 자리: 본문의 [ADD] 수, 옛 행(addMarkers 없음)은 AI 목록 수", () => {
    expect(countPortfolioAddMarkers("# 제목\n- [ADD: 팀 규모]\n- [ADD: 수치 확인 — 3배] 끝")).toBe(2);
    expect(countPortfolioAddMarkers("[ADD 아님]")).toBe(0);
    const base = { projectIds: [], postingId: null, notes: "", missingInfo: ["a", "b"], generatedAt: 0 };
    expect(portfolioOpenItems({ ...base, addMarkers: null })).toBe(2);
    expect(portfolioOpenItems({ ...base, addMarkers: 0 })).toBe(0);
    expect(portfolioOpenItems(null)).toBe(0);
  });
});

describe("기본 선택·진행 단계", () => {
  const opt = (id: string, done: number, hasMetric = false, skills = 0): GraphProjectOption => ({
    id,
    name: id,
    summary: "",
    period: "",
    done,
    total: 7,
    skills,
    hasMetric,
  });
  it("구조화가 잘 된 순으로 최대 n개(동률이면 그래프 순서)", () => {
    expect(defaultProjectSelection([opt("a", 1), opt("b", 5), opt("c", 1, true), opt("d", 1)], 3)).toEqual(["b", "c", "a"]);
  });
  it("graphPortfolioStepStates", () => {
    expect(graphPortfolioStepStates({ status: "running", stage: "writing" })).toEqual(["done", "active", "todo", "todo"]);
    expect(graphPortfolioStepStates({ status: "failed", stage: "material" })).toEqual(["failed", "todo", "todo", "todo"]);
    expect(graphPortfolioStepStates({ status: "completed", stage: "saving" })).toEqual(["done", "done", "done", "done"]);
  });
});
