import { describe, expect, it } from "vitest";
import {
  countMlSkills,
  DEFAULT_PORTFOLIO_TEMPLATE_ID,
  getPortfolioTemplate,
  isPortfolioTemplateId,
  PORTFOLIO_TEMPLATE_IDS,
  PORTFOLIO_TEMPLATES,
  PortfolioTemplateIdSchema,
  recommendPortfolioTemplate,
  templateTopSections,
} from "./portfolio-templates";

describe("포트폴리오 양식 목록", () => {
  it("6가지 양식이 id 순서대로 있고 기본은 project-pdf", () => {
    expect(PORTFOLIO_TEMPLATES.map((t) => t.id)).toEqual([...PORTFOLIO_TEMPLATE_IDS]);
    expect(PORTFOLIO_TEMPLATE_IDS).toEqual(["project-pdf", "notion-web", "career-case", "case-study", "github-readme", "ml-data"]);
    expect(DEFAULT_PORTFOLIO_TEMPLATE_ID).toBe("project-pdf");
  });

  it.each(PORTFOLIO_TEMPLATES.map((t) => [t.id, t] as const))("%s: 이름·대상·분량·구역이 있고 key가 겹치지 않으며 영문 소문자", (_, t) => {
    expect(t.name && t.description && t.audience && t.length).toBeTruthy();
    expect(t.project.some((s) => s.kind === "text" && !s.optional)).toBe(true);
    for (const list of [templateTopSections(t), t.project]) {
      const keys = list.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const s of list) {
        expect(s.key).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(s.heading.trim()).not.toBe("");
        expect(s.guide.trim()).not.toBe("");
      }
    }
    // 링크는 AI가 쓰지 않는 서버 구역뿐이고, 모든 양식이 프로젝트 링크 구역을 둔다.
    expect(t.project.find((s) => s.key === "links")?.kind).toBe("links");
    expect([...templateTopSections(t), ...t.project].filter((s) => s.kind !== "text").every((s) => ["skills", "links", "toc", "contact"].includes(s.key))).toBe(true);
  });

  it("조사한 양식의 핵심 구역 순서", () => {
    const keys = (id: string) => getPortfolioTemplate(id).project.map((s) => s.key);
    expect(keys("project-pdf")).toEqual(["overview", "skills", "problem", "solution", "result", "troubleshooting", "learned", "links"]);
    expect(keys("case-study").slice(0, 8)).toEqual(["problem", "role", "constraints", "approach", "decisions", "challenges", "result", "next"]);
    expect(keys("ml-data").slice(0, 6)).toEqual(["problem", "baseline", "data", "evaluation", "model", "result"]);
    // 케이스 스터디는 스택으로 시작하지 않는다.
    expect(getPortfolioTemplate("case-study").project[0]!.kind).toBe("text");
  });

  it("getPortfolioTemplate·검증: 모르는 id는 기본 양식, 스키마는 거절", () => {
    expect(getPortfolioTemplate("ml-data").name).toBe("AI·데이터형");
    expect(getPortfolioTemplate("x").id).toBe("project-pdf");
    expect(getPortfolioTemplate(null).id).toBe("project-pdf");
    expect(isPortfolioTemplateId("github-readme")).toBe(true);
    expect(isPortfolioTemplateId("__proto__")).toBe(false);
    expect(PortfolioTemplateIdSchema.safeParse("notion-web").success).toBe(true);
    expect(PortfolioTemplateIdSchema.safeParse("notion").success).toBe(false);
  });
});

describe("양식 추천", () => {
  it("ML·데이터 기술이 충분하면 ml-data", () => {
    expect(countMlSkills(["PyTorch", "pytorch", "Kotlin", "scikit-learn"])).toBe(2);
    expect(recommendPortfolioTemplate({ skillNames: ["PyTorch", "scikit-learn", "XGBoost", "Java", "Spring"], careerMonths: 60 }).id).toBe("ml-data");
    expect(recommendPortfolioTemplate({ skillNames: ["PyTorch", "MLflow", "TensorFlow"], careerMonths: 0 }).id).toBe("ml-data");
    // 2개뿐이면(비율이 높아도) 추천하지 않는다.
    expect(recommendPortfolioTemplate({ skillNames: ["PyTorch", "MLflow", "Python"], careerMonths: 0 }).id).toBe("project-pdf");
  });

  it("LLM·LangChain 같은 AI 활용 도구와 일반 데이터 도구는 ML 기술로 세지 않는다(백엔드 개발자에게 ml-data를 추천하지 않는다)", () => {
    const backend = ["Java", "Spring Boot", "MySQL", "Redis", "Kafka", "ChatGPT", "LangChain", "LLM", "RAG", "OpenAI API", "Pandas", "NumPy", "Spark"];
    expect(countMlSkills(backend)).toBe(0);
    expect(recommendPortfolioTemplate({ skillNames: backend, careerMonths: 0 }).id).toBe("project-pdf");
  });

  it("ML 기술이 일부뿐이면 경력 3년 이상은 career-case, 아니면 기본형", () => {
    const many = ["Java", "Spring", "MySQL", "Redis", "Kafka", "Docker", "AWS", "React", "pandas"];
    expect(recommendPortfolioTemplate({ skillNames: many, careerMonths: 36 })).toMatchObject({ id: "career-case" });
    expect(recommendPortfolioTemplate({ skillNames: many, careerMonths: 35 })).toMatchObject({ id: "project-pdf" });
    expect(recommendPortfolioTemplate({ skillNames: [], careerMonths: 0 }).reason).toBeTruthy();
  });
});
