import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESUME_TEMPLATE,
  draftSectionOrder,
  emptyResumeDocument,
  parseResumeDocument,
  performanceScaffold,
  RESUME_TEMPLATE_IDS,
  RESUME_TEMPLATES,
  ResumeDocumentSchema,
  ResumeDraftOutputSchema,
  splitHighlightDetails,
  toStoredHighlights,
  upgradeResumeHighlight,
} from "@/lib/domain/resumes";
import { toStrictJsonSchema } from "@/lib/llm/anthropic";
import { SaveResumeVersionSchema } from "./types";

/** 성과 중심 양식 필드가 생기기 전(라운드 1)에 저장한 버전 본문. */
const LEGACY_DOC = {
  basics: { name: "홍길동", headline: "백엔드", email: "a@b.c", phone: "", location: "서울", links: [{ label: "GitHub", url: "https://github.com/h" }] },
  summary: "요약",
  experience: [{ company: "페이랩", title: "개발자", startDate: "2021.03", endDate: "현재", location: "", bullets: ["결제 API 개선"] }],
  projects: [{ name: "정산", role: "리드", startDate: "", endDate: "", summary: "", bullets: [], techs: ["Kotlin"] }],
  skills: [{ category: "백엔드", items: ["Kotlin"] }],
  education: [{ school: "한국대", degree: "학사", major: "컴공", startDate: "", endDate: "", note: "" }],
  certifications: [],
  extras: [],
};

describe("예전 저장본 호환", () => {
  it("새 필드가 없는 문서는 엄격 스키마로는 실패하지만, parseResumeDocument는 빈 값으로 보정해 연다", () => {
    expect(ResumeDocumentSchema.safeParse(LEGACY_DOC).success).toBe(false);
    const r = parseResumeDocument(LEGACY_DOC);
    expect(r.success).toBe(true);
    const doc = r.data!;
    expect(doc.basics).toMatchObject({ name: "홍길동", headline: "백엔드", tagline: "", totalExperience: "", portfolioUrl: "", links: [{ label: "GitHub", url: "https://github.com/h" }] });
    expect(doc.highlights).toEqual([]);
    expect(doc.headings).toEqual({ highlights: "", experience: "", projects: "", skills: "", education: "" });
    expect(doc.experience[0]).toMatchObject({ company: "페이랩", department: "", scope: "", bullets: ["결제 API 개선"] });
    expect(doc.projects[0]).toMatchObject({ name: "정산", role: "리드", team: "", problem: "", evidence: "", techs: ["Kotlin"] });
    expect(doc.skills[0]).toEqual({ category: "백엔드", detail: "", items: ["Kotlin"] });
    // 보정은 입력을 바꾸지 않는다
    expect("highlights" in LEGACY_DOC).toBe(false);
  });

  it("배열·basics 키가 아예 빠진 문서(엔진 출력·옛 저장본)도 빈 값으로 보정한다", () => {
    const r = parseResumeDocument({ summary: "요약만 있는 문서" });
    expect(r.success).toBe(true);
    expect(r.data!.basics.name).toBe("");
    expect(r.data!).toMatchObject({ experience: [], projects: [], skills: [], education: [], certifications: [], extras: [] });
    const partial = parseResumeDocument({ basics: { name: "홍길동" }, education: [{ school: "한국대" }], certifications: [{ name: "정보처리기사" }] });
    expect(partial.success).toBe(true);
    expect(partial.data!.education[0]).toMatchObject({ school: "한국대", degree: "", major: "" });
    expect(partial.data!.certifications[0]).toEqual({ name: "정보처리기사", issuer: "", date: "" });
  });

  it("한 줄 소개(tagline)가 생기기 전 문서는 tagline을 빈 값으로 채우고, 문장형 headline도 옮기지 않고 그대로 둔다", () => {
    const sentence = "결제 지연을 줄여 온 5년 차 백엔드 개발자";
    const oldBasics: Record<string, unknown> = { ...emptyResumeDocument().basics, headline: sentence };
    delete oldBasics.tagline;
    const r = parseResumeDocument({ ...emptyResumeDocument(), basics: oldBasics });
    expect(r.success).toBe(true);
    expect(r.data!.basics.headline).toBe(sentence);
    expect(r.data!.basics.tagline).toBe("");
    expect(emptyResumeDocument().basics.tagline).toBe("");
    expect(parseResumeDocument({ ...emptyResumeDocument(), basics: { ...emptyResumeDocument().basics, tagline: "가".repeat(201) } }).success).toBe(false);
  });

  it("버전 저장 API 입력도 예전 형식을 받아들인다", () => {
    const r = SaveResumeVersionSchema.safeParse({ document: LEGACY_DOC });
    expect(r.success).toBe(true);
    expect(r.data!.document.experience[0]!.department).toBe("");
  });

  it("형식이 아예 틀리거나 길이 한도를 넘으면 여전히 실패한다", () => {
    expect(parseResumeDocument(null).success).toBe(false);
    expect(parseResumeDocument("문서").success).toBe(false);
    expect(parseResumeDocument({ ...LEGACY_DOC, experience: "x" }).success).toBe(false);
    expect(parseResumeDocument({ ...LEGACY_DOC, basics: { ...LEGACY_DOC.basics, name: "가".repeat(81) } }).success).toBe(false);
  });

  it("현재 형식 문서는 그대로 통과한다", () => {
    const doc = performanceScaffold();
    expect(parseResumeDocument(doc).data).toEqual(doc);
    expect(ResumeDocumentSchema.safeParse(doc).success).toBe(true);
  });
});

describe("성과 중심 양식", () => {
  it("첫 번째·기본 양식이고 양식은 6개 이하", () => {
    expect(RESUME_TEMPLATE_IDS[0]).toBe("performance");
    expect(DEFAULT_RESUME_TEMPLATE).toBe("performance");
    expect(RESUME_TEMPLATE_IDS.length).toBeLessThanOrEqual(6);
    expect(RESUME_TEMPLATES.performance.style).toMatchObject({ accent: "#264e77", layout: "labeled" });
  });

  it("빈 뼈대는 원본 예시 구조(성과 2·경력 2·프로젝트 2·역량 2·학력 1·자격 1)를 빈 항목으로 깐다", () => {
    const d = performanceScaffold();
    expect([d.highlights.length, d.experience.length, d.projects.length, d.skills.length, d.education.length, d.certifications.length]).toEqual([
      2, 2, 2, 2, 1, 1,
    ]);
    expect(d.experience[0]!.bullets).toEqual([""]);
    expect(d.experience[1]!.bullets).toEqual([]);
    // 이미 있는 항목은 지우지 않고 모자란 만큼만 채운다
    const base = emptyResumeDocument();
    base.highlights = [{ title: "a", details: [], context: "" }, { title: "b", details: [], context: "" }, { title: "c", details: [], context: "" }];
    expect(performanceScaffold(base).highlights.map((h) => h.title)).toEqual(["a", "b", "c"]);
  });
});

describe("초안 스키마(ResumeDraftOutputSchema)", () => {
  it("구조화 출력 JSON 스키마는 새 필드를 모두 필수로 요구한다", () => {
    const json = toStrictJsonSchema(ResumeDraftOutputSchema) as {
      properties: { document: { required: string[]; properties: Record<string, { required?: string[]; items?: { required: string[] } }> } };
    };
    const docSchema = json.properties.document;
    expect(docSchema.required).toEqual(expect.arrayContaining(["basics", "summary", "headings", "highlights", "experience", "projects", "skills"]));
    expect(docSchema.properties.basics!.required).toEqual(expect.arrayContaining(["headline", "tagline", "totalExperience", "portfolioUrl"]));
    // 핵심 성과: 성과 요약 + 상세 성과 줄. 예전 칸 context는 LLM 출력 스키마에 없다(저장 스키마에만 남는다).
    expect(docSchema.properties.highlights!.items!.required).toEqual(["title", "details"]);
    expect(docSchema.properties.experience!.items!.required).toEqual(expect.arrayContaining(["department", "scope"]));
    expect(docSchema.properties.projects!.items!.required).toEqual(
      expect.arrayContaining(["company", "team", "role", "problem", "action", "result", "evidence"]),
    );
    expect(docSchema.properties.skills!.items!.required).toEqual(expect.arrayContaining(["category", "detail", "items"]));
  });

  it("검증은 보정을 거친다: 엔진이 새 필드를 빠뜨려도 빈 값으로 받는다", () => {
    const r = ResumeDraftOutputSchema.safeParse({ document: LEGACY_DOC, notes: [], missingInfo: ["수치는?"] });
    expect(r.success).toBe(true);
    expect(r.data!.document.projects[0]!.result).toBe("");
  });
});

describe("지원 동기(motivation)", () => {
  it("칸이 없던 예전 저장본은 빈 문자열로 열고, 상한(1500자)을 지킨다", () => {
    const { motivation: _omit, ...old } = emptyResumeDocument();
    void _omit;
    expect(ResumeDocumentSchema.safeParse(old).success).toBe(false);
    expect(parseResumeDocument(old).data!.motivation).toBe("");
    expect(parseResumeDocument({ ...old, motivation: null }).data!.motivation).toBe("");
    expect(parseResumeDocument({ ...old, motivation: "가".repeat(1500) }).success).toBe(true);
    expect(parseResumeDocument({ ...old, motivation: "가".repeat(1501) }).success).toBe(false);
    expect(parseResumeDocument(LEGACY_DOC).data!.motivation).toBe("");
  });

  it("AI 초안 출력 스키마에는 지원 동기 칸이 없다(사용자가 쓴다)", () => {
    const json = toStrictJsonSchema(ResumeDraftOutputSchema) as { properties: { document: { properties: Record<string, unknown>; required: string[] } } };
    expect(Object.keys(json.properties.document.properties)).not.toContain("motivation");
    expect(json.properties.document.required).not.toContain("motivation");
    // 모델이 motivation을 보내도 버린다.
    const r = ResumeDraftOutputSchema.safeParse({ document: { ...emptyResumeDocument(), motivation: "AI가 쓴 지원 동기" }, notes: [], missingInfo: [] });
    expect(r.success).toBe(true);
    expect("motivation" in r.data!.document).toBe(false);
  });

  it("양식 섹션 순서 끝에 '지원 동기'가 있고, AI 초안 섹션 순서에서는 빠진다", () => {
    for (const id of RESUME_TEMPLATE_IDS) {
      expect(RESUME_TEMPLATES[id].sectionOrder.at(-1)).toBe("motivation");
      expect(draftSectionOrder(RESUME_TEMPLATES[id].sectionOrder)).not.toContain("motivation");
    }
  });
});

describe("핵심 성과: 성과 요약 + 상세 성과 줄(details) — 예전 칸 context 보정", () => {
  const legacy = (highlights: unknown[]) => ({ ...emptyResumeDocument(), highlights });

  it("details 없이 context만 있는 예전 문서는 줄바꿈 기준으로 details에 옮기고 context를 비운다(입력은 그대로)", () => {
    const raw = legacy([
      { title: "정산 4시간 → 40분", context: "2023년 월말 정산 대상\r\n\n  배치를 병렬화했습니다.  " },
      { title: "빈 성과", context: "" },
      { title: "키 없음" },
    ]);
    const before = structuredClone(raw);
    const r = parseResumeDocument(raw);
    expect(r.success).toBe(true);
    expect(r.data!.highlights).toEqual([
      { title: "정산 4시간 → 40분", details: ["2023년 월말 정산 대상", "배치를 병렬화했습니다."], context: "" },
      { title: "빈 성과", details: [], context: "" },
      { title: "키 없음", details: [], context: "" },
    ]);
    expect(raw).toEqual(before);
  });

  it("details가 이미 있으면 그대로 두고, 남은 context 줄은 뒤에 붙인다. 5줄을 넘으면 남는 줄을 마지막 줄에 이어 붙인다", () => {
    expect(upgradeResumeHighlight({ title: "t", details: ["a"], context: "" })).toEqual({ title: "t", details: ["a"], context: "" });
    expect(upgradeResumeHighlight({ title: "t", details: ["a"], context: "b\nc" })).toEqual({ title: "t", details: ["a", "b", "c"], context: "" });
    expect(upgradeResumeHighlight({ title: "t", details: ["a", "b", "c", "d"], context: "e\nf\ng" })).toEqual({ title: "t", details: ["a", "b", "c", "d", "e f g"], context: "" });
    expect(splitHighlightDetails(" a \n\n b\r\nc ")).toEqual(["a", "b", "c"]);
  });

  it("형식이 아예 다르면 손대지 않아 스키마가 거절한다", () => {
    expect(upgradeResumeHighlight("x")).toBe("x");
    expect(parseResumeDocument(legacy([{ title: "t", details: "a" }])).success).toBe(false);
    expect(parseResumeDocument(legacy([{ title: "t", details: Array.from({ length: 6 }, () => "x") }])).success).toBe(false);
    expect(parseResumeDocument(legacy([{ title: "t", details: ["x".repeat(301)] }])).success).toBe(false);
  });

  it("LLM 초안 출력은 context 없는 모양으로 받고, 예전 모양(context)으로 와도 details로 옮긴다", () => {
    const r = ResumeDraftOutputSchema.safeParse({ document: { ...LEGACY_DOC, highlights: [{ title: "t", context: "a\nb" }] }, notes: [], missingInfo: [] });
    expect(r.success).toBe(true);
    expect(r.data!.document.highlights).toEqual([{ title: "t", details: ["a", "b"] }]);
    expect(toStoredHighlights(r.data!.document.highlights)).toEqual([{ title: "t", details: ["a", "b"], context: "" }]);
    const strict = toStrictJsonSchema(ResumeDraftOutputSchema) as { properties: { document: { properties: { highlights: { items: { properties: Record<string, unknown> } } } } } };
    expect(Object.keys(strict.properties.document.properties.highlights.items.properties)).toEqual(["title", "details"]);
    // 저장 스키마에는 예전 칸이 남는다(빈 문자열).
    expect(Object.keys(ResumeDocumentSchema.shape.highlights.element.shape)).toEqual(["title", "details", "context"]);
  });
});
