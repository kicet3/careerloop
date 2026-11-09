import { describe, expect, it } from "vitest";
import { EMPTY_RESUME_ITEM, emptyResumeDocument, performanceScaffold, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES } from "@/lib/domain/resumes";
import { makeSampleResume } from "./__fixtures__/sample";
import { countAddMarkers, isSectionEmpty, period, resumeLayout, resumeToText, splitAddMarkers } from "./layout";

describe("resumeLayout", () => {
  it("양식의 섹션 순서를 따르고 빈 섹션은 뺀다", () => {
    const doc = makeSampleResume();
    doc.extras = [];
    for (const id of RESUME_TEMPLATE_IDS) {
      const { main, side } = resumeLayout(doc, id);
      const expected = RESUME_TEMPLATES[id].sectionOrder.filter((k) => k !== "extras");
      expect([...main, ...side].sort()).toEqual([...expected].sort());
      expect(main).toEqual(expected.filter((k) => main.includes(k)));
    }
  });

  it("사이드바 양식(developer)은 기술·학력·자격을 옆 열로 보낸다", () => {
    const { main, side } = resumeLayout(makeSampleResume(), "developer");
    expect(side).toEqual(["skills", "education", "certifications"]);
    expect(main).toEqual(["summary", "highlights", "experience", "projects", "extras", "motivation"]);
    expect(resumeLayout(makeSampleResume(), "classic").side).toEqual([]);
  });

  it("빈 문서는 섹션이 없다", () => {
    const doc = emptyResumeDocument();
    doc.experience = [{ ...EMPTY_RESUME_ITEM.experience(), company: " ", startDate: "2020", bullets: [""] }];
    expect(isSectionEmpty(doc, "experience")).toBe(true);
    expect(resumeLayout(doc, "modern")).toEqual({ main: [], side: [] });
  });
});

describe("텍스트 도우미", () => {
  it("period", () => {
    expect(period("2021.03", "현재")).toBe("2021.03 – 현재");
    expect(period("", "2020.01")).toBe("2020.01");
    expect(period(" ", "")).toBe("");
  });

  it("[ADD: ...] 자리표시를 나누고 센다", () => {
    expect(splitAddMarkers("앞 [ADD: 수치] 뒤")).toEqual([
      { text: "앞 ", add: false },
      { text: "[ADD: 수치]", add: true },
      { text: " 뒤", add: false },
    ]);
    expect(countAddMarkers(makeSampleResume())).toBe(1);
  });

  it("resumeToText: 양식 순서대로 진단 입력용 텍스트를 만든다", () => {
    const text = resumeToText(makeSampleResume(), "career-change");
    expect(
      text.startsWith(
        "# 홍길동\n백엔드 개발자 · 총 경력 5년 2개월\nhong@example.com | 010-0000-0000 | 서울 | https://hong.dev | GitHub: https://github.com/hong\n\n결제·정산 지연을 줄여 온 5년 차 백엔드 개발자\n",
      ),
    ).toBe(true);
    const order = ["## 요약", "## 핵심 성과", "## 기술", "## 프로젝트", "## 경력", "## 학력", "## 자격·어학", "## 기타"].map((h) => text.indexOf(h));
    expect(order.every((x) => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("### 페이랩 | 결제플랫폼팀 | 백엔드 개발자 | 2021.03 – 현재 | 서울");
    expect(text).toContain("결제 API와 정산 배치의 설계·운영을 맡았습니다.");
    expect(text).toContain("- 정산 배치 처리 시간 4시간 → 40분 · 83% 단축\n  - 2023년 월말 정산 배치 대상으로 측정했습니다.\n  - 배치 구조를 재설계하고 병렬화했습니다.");
    expect(text).toContain("- 문제: 대사 오류 로그로 수기 정산 누락을 확인.");
    expect(text).toContain("- 결제 API 응답 시간을 40% 줄였습니다.");
    expect(text).toContain("- 백엔드: Kotlin, Spring, MySQL");
    expect(text).toContain("기술: Kotlin, Spring Batch");
    expect(resumeToText(emptyResumeDocument(), "classic")).toBe("");
    // 빈 뼈대(성과 양식 새 문서)도 빈 텍스트
    expect(resumeToText(performanceScaffold(), "performance")).toBe("");
  });

  it("바꾼 섹션 제목은 다른 양식에도 쓰인다(경력 → 관련 경험)", () => {
    const doc = makeSampleResume();
    doc.headings.experience = "관련 경험";
    expect(resumeToText(doc, "classic")).toContain("## 관련 경험");
  });
});

describe("프로젝트 근거 칸(evidence)", () => {
  it("evidence만 있는 프로젝트는 빈 항목으로 본다(화면·PDF에 내보내지 않는 칸)", () => {
    const doc = emptyResumeDocument();
    doc.projects = [{ ...EMPTY_RESUME_ITEM.project(), evidence: "정산 대시보드" }];
    expect(isSectionEmpty(doc, "projects")).toBe(true);
    expect(resumeToText(doc, "classic")).toBe("");
  });
});
