import { describe, expect, it } from "vitest";
import { getAt, itemPathOf, linePaths, locateQuote, numberedDocText, parseCitations, refsForLine, resolvePath, shiftCitations } from "./citations";
import { CitePathSchema, DocPathSchema } from "./schemas";
import { draft, exp, proj } from "./__fixtures__/units";

const doc = draft({ summary: "요약 문장", experience: [exp({ scope: "주문 서버 운영", bullets: ["Kafka로 주문 이벤트를 나눴다", "배포 자동화"] })], projects: [proj({ action: "Redis 캐시 계층 설계" })] }).document;

describe("경로 문법·해석", () => {
  it("줄 경로와 항목 경로를 구분한다", () => {
    expect(DocPathSchema.safeParse("experience[0].bullets[1]").success).toBe(true);
    expect(DocPathSchema.safeParse("experience[0]").success).toBe(false);
    expect(CitePathSchema.safeParse("experience[0]").success).toBe(true);
    expect(CitePathSchema.safeParse("experience[0].company").success).toBe(false);
    expect(CitePathSchema.safeParse("basics.email").success).toBe(false);
  });

  it("getAt·resolvePath: 있는 경로만", () => {
    expect(getAt(doc, "experience[0].bullets[1]")).toBe("배포 자동화");
    expect(resolvePath(doc, "experience[0].bullets[1]")).toBe(true);
    expect(resolvePath(doc, "experience[0].bullets[2]")).toBe(false);
    expect(resolvePath(doc, "experience[1]")).toBe(false);
    expect(resolvePath(doc, "projects[0]")).toBe(true);
  });

  it("줄의 근거 = 줄 인용 ∪ 상위 항목 인용", () => {
    const cites = [
      { path: "experience[0]", refs: ["E1"], requirementIds: [] },
      { path: "experience[0].bullets[0]", refs: ["E2"], requirementIds: ["R1"] },
      { path: "summary", refs: ["E3"], requirementIds: [] },
    ];
    expect(refsForLine(cites, "experience[0].bullets[0]").sort()).toEqual(["E1", "E2"]);
    expect(refsForLine(cites, "experience[0].bullets[1]")).toEqual(["E1"]);
    expect(refsForLine(cites, "basics.tagline")).toEqual(["E3"]);
    expect(itemPathOf("extras[0].items[2]")).toBe("extras[0].items[2]");
  });

  it("parseCitations: 문법 오류·없는 경로·pack 밖 ref·모르는 요건을 버리고, 같은 경로는 합친다", () => {
    const { citations, invalidRefPaths } = parseCitations(
      [
        { path: "experience[0]", refs: ["E1", "E9"], requirementIds: ["R1", "R99"] },
        { path: "experience[0]", refs: ["[E2]"], requirementIds: [] },
        { path: "experience[3]", refs: ["E1"], requirementIds: [] },
        { path: "basics.email", refs: ["E1"], requirementIds: [] },
        { path: "projects[0]", refs: ["E9"], requirementIds: [] },
      ],
      doc,
      new Set(["E1", "E2"]),
      new Set(["R1"]),
    );
    expect(citations).toEqual([{ path: "experience[0]", refs: ["E1", "E2"], requirementIds: ["R1"] }]);
    expect(invalidRefPaths).toEqual(["projects[0]"]);
  });
});

describe("locateQuote", () => {
  it("글머리표·'행동:' 접두·공백 차이를 무시하고 줄 경로를 찾는다", () => {
    expect(locateQuote(doc, "- Kafka로 주문  이벤트를 나눴다")).toEqual(["experience[0].bullets[0]"]);
    expect(locateQuote(doc, "행동: Redis 캐시 계층 설계")).toEqual(["projects[0].action"]);
    expect(locateQuote(doc, "없는 문장입니다")).toEqual([]);
    expect(locateQuote(doc, null)).toEqual([]);
  });
});

describe("인용 경로 이동", () => {
  it("원소 삭제·삽입 뒤 뒤쪽 원소의 인용 번호가 따라간다", () => {
    const cites = [
      { path: "experience[0].bullets[0]", refs: ["E1"], requirementIds: [] },
      { path: "experience[0].bullets[2]", refs: ["E2"], requirementIds: [] },
      { path: "experience[0]", refs: ["E3"], requirementIds: [] },
    ];
    expect(shiftCitations(cites, "experience[0].bullets", 0, -1).map((c) => c.path)).toEqual(["experience[0].bullets[1]", "experience[0]"]);
    expect(shiftCitations(cites, "experience[0].bullets", 1, 1).map((c) => c.path)).toEqual(["experience[0].bullets[0]", "experience[0].bullets[3]", "experience[0]"]);
  });

  it("linePaths·numberedDocText", () => {
    expect(linePaths(doc).map((l) => l.path)).toContain("experience[0].bullets[1]");
    expect(numberedDocText(doc)).toContain("[experience[0].bullets[0]] Kafka로 주문 이벤트를 나눴다");
  });
});
