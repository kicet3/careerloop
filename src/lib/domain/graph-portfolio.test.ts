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
  coreSkills: ["Kotlin", " Spring "],
  sections: [
    { key: "retrospective", body: "운영 안정성에 관심이 많다.", bullets: [] },
    { key: "intro", body: "결제·정산 도메인에서 일했습니다.", bullets: [] },
    { key: "made-up", body: "양식에 없는 구역", bullets: [] },
  ],
  projects: [
    {
      projectId: "p1",
      name: "정산 개편",
      oneLiner: "정산 배치를 다시 만들었다",
      period: "2024.01 ~ 2024.06",
      affiliation: "페이랩",
      techStack: ["Kotlin", "a`b"],
      sections: [
        { key: "result", body: "", bullets: ["정산 시간 6시간→40분", " "] },
        { key: "solution", body: "", bullets: ["청크 처리로 바꿈", "인덱스 추가"] },
        { key: "problem", body: "하루 정산이 6시간 걸렸다.", bullets: [] },
        { key: "Overview", body: "백엔드 리드", bullets: [] },
        { key: "problem", body: "중복 구역은 버린다", bullets: [] },
      ],
    },
  ],
  notes: [],
  missingInfo: [],
  ...over,
});

const at = (md: string, s: string) => {
  const i = md.indexOf(s);
  expect(i, s).toBeGreaterThanOrEqual(0);
  return i;
};

describe("graphPortfolioToMarkdown", () => {
  it("기본 양식(project-pdf): 양식의 구역 순서·제목대로, 빈 선택 구역은 쓰지 않고 필수 구역은 [ADD], 링크는 서버 주소로", () => {
    const md = graphPortfolioToMarkdown(output(), {
      title: "백엔드 포트폴리오",
      personName: "홍길동",
      links: new Map([["p1", [{ label: "GitHub · u/[pay]", url: "https://github.com/u/pay" }]]]),
    });
    expect(md.startsWith("# 백엔드 포트폴리오\n")).toBe(true);
    expect(md).toContain("**홍길동**");
    expect(md).toContain("> 정산을 빠르게 만드는 백엔드 개발자");
    expect(md).toContain("## 자기소개\n\n결제·정산 도메인에서 일했습니다.");
    expect(md).toContain("## 기술 스택\n\nKotlin · Spring");
    expect(md).toContain("## 목차\n\n1. 정산 개편");
    expect(md).toContain("## 1. 정산 개편");
    expect(md).toContain("2024.01 ~ 2024.06 · 페이랩");
    expect(md).toContain("### 기술 스택\n\n`Kotlin` `ab`");
    expect(md).toContain("### 해결\n\n- 청크 처리로 바꿈\n- 인덱스 추가");
    expect(md).toContain("### 결과\n\n- 정산 시간 6시간→40분\n");
    expect(md).not.toContain("중복 구역");
    expect(md).not.toContain("양식에 없는 구역");
    expect(md).not.toContain("트러블슈팅");
    expect(md).not.toContain("배운 점");
    expect(md).toContain("- [GitHub · u/pay](https://github.com/u/pay)");
    // 순서: 앞 구역 → 프로젝트(개요 → 기술 → 문제 → 해결 → 결과 → 링크) → 뒤 구역
    const order = ["## 자기소개", "## 기술 스택", "## 목차", "## 1. 정산 개편", "### 개요", "### 기술 스택", "### 문제", "### 해결", "### 결과", "### 링크", "## 회고·성장 방향"];
    const idx = order.map((s) => at(md, s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("필수 구역이 비면 [ADD: … 보완 필요], 링크가 없으면 링크 구역이 없다", () => {
    const md = graphPortfolioToMarkdown(output({ sections: [], projects: [{ ...output().projects[0]!, sections: [] }] }), { title: "" });
    expect(md.startsWith("# 포트폴리오")).toBe(true);
    expect(md).toContain("## 자기소개\n\n[ADD: 자기소개 보완 필요]");
    expect(md).toContain("### 문제\n\n[ADD: 문제 보완 필요]");
    expect(md).not.toContain("### 링크");
    expect(md).not.toContain("회고·성장 방향");
  });

  it("다른 양식(case-study): 그 양식의 제목·순서·머리말, 다른 양식의 key는 쓰지 않는다", () => {
    const md = graphPortfolioToMarkdown(
      output({
        sections: [],
        projects: [
          {
            ...output().projects[0]!,
            sections: [
              { key: "result", body: "40분으로 줄었다.", bullets: [] },
              { key: "problem", body: "정산이 느렸다.", bullets: [] },
              { key: "decisions", body: "", bullets: ["배치 → 스트림 대신 청크(운영 단순)"] },
              { key: "overview", body: "project-pdf 전용 구역", bullets: [] },
            ],
          },
        ],
      }),
      { title: "케이스", templateId: "case-study" },
    );
    expect(md).toContain("## Case 1. 정산 개편");
    expect(md).not.toContain("project-pdf 전용 구역");
    expect(md).not.toContain("## 기술 스택");
    const idx = ["### Problem · 문제", "### Role · 역할", "### Approach · 접근", "### Decisions · 결정과 트레이드오프", "### Result · 결과", "### Stack · 기술"].map((s) => at(md, s));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(md).toContain("### Role · 역할\n\n[ADD: Role · 역할 보완 필요]");
  });

  it("노션형: 연락처에는 프로젝트 저장소 주소를 넣지 않고 본인 GitHub 프로필만 붙이며 나머지는 [ADD]", () => {
    const links = new Map([["p1", [{ label: "GitHub", url: "https://github.com/u/pay" }]]]);
    const md = graphPortfolioToMarkdown(output(), { title: "", templateId: "notion-web", links });
    const contact = md.slice(md.indexOf("## 연락처"));
    expect(contact).not.toContain("https://github.com/u/pay");
    expect(contact).toContain("## 연락처\n\n- [ADD: 이메일·GitHub·블로그 주소]");
    // 프로젝트 링크는 프로젝트의 '링크' 구역에 그대로 있다.
    expect(md).toContain("### 링크\n\n- [GitHub](https://github.com/u/pay)");

    const withProfile = graphPortfolioToMarkdown(output(), {
      title: "",
      templateId: "notion-web",
      links,
      contactLinks: [{ label: "GitHub · hong", url: "https://github.com/hong" }],
    });
    const c2 = withProfile.slice(withProfile.indexOf("## 연락처"));
    expect(c2).toContain("- [GitHub · hong](https://github.com/hong)\n- [ADD: 이메일·블로그 주소]");
    expect(c2).not.toContain("u/pay");
  });

  it("모르는 양식 id는 기본 양식으로 그린다", () => {
    expect(graphPortfolioToMarkdown(output(), { title: "", templateId: "nope" })).toContain("## 자기소개");
  });
});

describe("시작 입력·생성 정보", () => {
  it("StartGraphPortfolioSchema: 프로젝트 1~12개, 중복 제거", () => {
    expect(StartGraphPortfolioSchema.parse({ projectIds: ["a", "a", "b"] }).projectIds).toEqual(["a", "b"]);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: [] }).success).toBe(false);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: Array.from({ length: 13 }, (_, i) => `p${i}`) }).success).toBe(false);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: ["a"], notes: "x".repeat(1001) }).success).toBe(false);
  });

  it("StartGraphPortfolioSchema: 양식은 기본 project-pdf, 아는 양식만", () => {
    expect(StartGraphPortfolioSchema.parse({ projectIds: ["a"] }).templateId).toBe("project-pdf");
    expect(StartGraphPortfolioSchema.parse({ projectIds: ["a"], templateId: "ml-data" }).templateId).toBe("ml-data");
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: ["a"], templateId: "fancy" }).success).toBe(false);
    expect(StartGraphPortfolioSchema.safeParse({ projectIds: ["a"], templateId: null }).success).toBe(false);
  });

  it("parseGraphPortfolioSource: 틀린 칸은 기본값, 객체가 아니면 null", () => {
    expect(parseGraphPortfolioSource(null)).toBeNull();
    expect(parseGraphPortfolioSource({ projectIds: ["p1"], postingId: 3 })).toEqual({ projectIds: ["p1"], postingId: null, notes: "", missingInfo: [], generatedAt: 0, addMarkers: null, templateId: null });
    expect(parseGraphPortfolioSource({ projectIds: [], templateId: "github-readme" })?.templateId).toBe("github-readme");
    expect(parseGraphPortfolioSource({ projectIds: [], templateId: "fancy" })?.templateId).toBeNull();
  });

  it("채워야 할 자리: 본문의 [ADD] 수, 옛 행(addMarkers 없음)은 AI 목록 수", () => {
    expect(countPortfolioAddMarkers("# 제목\n- [ADD: 팀 규모]\n- [ADD: 수치 확인 — 3배] 끝")).toBe(2);
    expect(countPortfolioAddMarkers("[ADD 아님]")).toBe(0);
    const base = { projectIds: [], postingId: null, notes: "", missingInfo: ["a", "b"], generatedAt: 0, templateId: null };
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
