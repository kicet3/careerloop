/** 날짜 칸을 쓰는 화면(그래프 노드 폼·이력서 구조화 폼·성과 시트)이 MonthInput·달력 버튼을 쓰는지 정적 렌더로 본다. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NodeForm } from "@/components/graph/NodeForm";
import { PerformanceSheet } from "@/components/resumes/PerformanceSheet";
import { ResumeDocumentForm } from "@/components/resumes/ResumeDocumentForm";
import type { CareerGraph, GraphNode } from "@/lib/domain/graph";
import { emptyResumeDocument, EMPTY_RESUME_ITEM, performanceScaffold, RESUME_SECTION_KEYS } from "@/lib/domain/resumes";

const graph: CareerGraph = { person: { id: "me", name: null }, nodes: [], edges: [] };
const noop = async () => {};
const count = (html: string, s: string) => html.split(s).length - 1;

describe("NodeForm 날짜 칸", () => {
  it("Role: 시작·종료가 MonthInput(달력 버튼), '현재 재직 중'은 종료 칸 안 체크 하나뿐", () => {
    const node = {
      id: "r1",
      label: "Role",
      props: { title: "백엔드", startDate: "2021-03", current: true },
      createdAt: 0,
      updatedAt: 0,
    } as unknown as GraphNode;
    const html = renderToStaticMarkup(<NodeForm graph={graph} node={node} onSubmit={noop} onCancel={() => {}} />);
    expect(count(html, 'aria-label="달력에서 고르기"')).toBe(2);
    expect(html).toContain('value="2021-03"');
    expect(count(html, "현재 재직 중")).toBe(1);
    // 진행 중이면 종료 칸은 '현재'로 비활성.
    expect(html).toMatch(/<input[^>]*type="text"[^>]*disabled=""[^>]*value="현재"/);
  });

  it("Certification 취득일도 MonthInput, '현재' 체크는 없다", () => {
    const html = renderToStaticMarkup(<NodeForm graph={graph} initialLabel="Certification" onSubmit={noop} onCancel={() => {}} />);
    expect(count(html, 'aria-label="달력에서 고르기"')).toBe(1);
    expect(html).not.toContain(">현재<");
  });
});

describe("ResumeDocumentForm 날짜 칸", () => {
  it("경력·프로젝트·학력 시작/종료가 MonthInput(dot), 종료에만 '현재' 체크", () => {
    const doc = emptyResumeDocument();
    doc.experience = [{ ...EMPTY_RESUME_ITEM.experience(), startDate: "2021.03", endDate: "현재" }];
    doc.projects = [EMPTY_RESUME_ITEM.project()];
    doc.education = [EMPTY_RESUME_ITEM.education()];
    const html = renderToStaticMarkup(<ResumeDocumentForm value={doc} onChange={() => {}} sectionOrder={RESUME_SECTION_KEYS} />);
    expect(count(html, 'aria-label="달력에서 고르기"')).toBe(6);
    expect(count(html, 'type="checkbox"')).toBe(3);
    expect(html).toContain('value="2021.03"');
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
  });
});

describe("PerformanceSheet 날짜 칸", () => {
  it("편집 모드: 기간 칸마다 이름 붙은 달력 버튼, 칸은 그대로 contenteditable", () => {
    const html = renderToStaticMarkup(<PerformanceSheet document={performanceScaffold()} onChange={() => {}} />);
    expect(html).toContain('aria-label="최근 경력 시작 달력에서 고르기"');
    expect(html).toContain('aria-label="최근 경력 종료 달력에서 고르기"');
    expect(html).toContain('aria-label="학력 1 시작 달력에서 고르기"');
    expect(html).toMatch(/data-field="experience\.0\.startDate"/);
    expect(html).toContain('class="relative inline-flex pf-date-pick"');
  });

  it("읽기 전용에는 달력 버튼이 없다", () => {
    const html = renderToStaticMarkup(<PerformanceSheet document={performanceScaffold()} />);
    expect(html).not.toContain("달력에서 고르기");
    expect(html).not.toContain("pf-date");
  });
});
