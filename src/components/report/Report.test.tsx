import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildReportModel } from "@/lib/report/model";
import { SAMPLE_OUTPUTS, makeSampleDiagnosis, makeSampleReport, makeSampleStages } from "@/lib/report/__fixtures__/sample";
import { Report } from "./Report";
import { parseMarkdownBlocks } from "./MiniMarkdown";

describe("Report", () => {
  it("전체 보고서를 섹션 순서대로 렌더링한다", () => {
    const html = renderToStaticMarkup(<Report report={makeSampleReport()} actions={<button>PDF</button>} />);
    const order = ["summary", "reviewers", "jd", "mistakes", "plan", "rewrite", "details", "disclaimer"].map((id) =>
      html.indexOf(`id="${id}"`),
    );
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("2/7 통과");
    expect(html).toContain("<button>PDF</button>");
    expect(html).toContain("원문에서 찾지 못함");
    expect(html).toContain("[ADD: 일 평균 결제 건수]");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("부분 데이터와 추정 JD도 렌더링한다", () => {
    const stages = makeSampleStages({
      omit: ["synthesis", "rewrite", "plan", "rescreen", "ceo", "fit"],
      outputs: { jd: { ...SAMPLE_OUTPUTS.jd, source: "inferred" } },
    });
    const html = renderToStaticMarkup(<Report report={buildReportModel(makeSampleDiagnosis({ jdText: null }), stages)} />);
    expect(html).toContain("공고 없이 직무명으로 추정한 요건입니다.");
    expect(html).toContain("미완료");
    expect(html).toContain("이력서 재작성이 아직 완료되지 않았습니다.");
  });

  it("Markdown의 HTML은 텍스트로 이스케이프된다", () => {
    const r = makeSampleReport();
    r.rewrite!.resumeMarkdown = "# 이름\n<script>alert(1)</script>\n- [링크](javascript:alert(1))";
    const html = renderToStaticMarkup(<Report report={r} />);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('href="javascript');
  });
});

describe("Report — 리뷰 수정 사항", () => {
  it("문제점 번호는 rank, 매트릭스는 모바일 카드와 표를 함께 내고 공고 인용을 보여 준다", () => {
    const synthesis = {
      ...SAMPLE_OUTPUTS.synthesis,
      mistakes: SAMPLE_OUTPUTS.synthesis.mistakes.slice(0, 2).map((m, i) => ({ ...m, rank: i === 0 ? 1 : 4 })),
    };
    const r = buildReportModel(makeSampleDiagnosis(), makeSampleStages({ outputs: { synthesis } }));
    const html = renderToStaticMarkup(<Report report={r} />);
    const mistakes = html.slice(html.indexOf('id="mistakes"'), html.indexOf('id="plan"'));
    expect(mistakes).toMatch(/>4<\/span>/);
    expect(mistakes).not.toMatch(/>2<\/span>/);
    const jd = html.slice(html.indexOf('id="jd"'), html.indexOf('id="mistakes"'));
    expect(jd).toContain("sm:hidden"); // 모바일 카드
    expect(jd).not.toContain("min-w-[640px]");
    expect(jd).toContain("“Kotlin 실무 경험”");
  });

  it("재심사가 여전히 탈락이면 근거(재작성본 인용)와 파싱 문제를 보여 준다", () => {
    const rescreen = {
      ...SAMPLE_OUTPUTS.rescreen,
      verdict: "REJECT" as const,
      reasons: [{ quote: "재작성본에 없는 줄", issue: "연차 표기가 여전히 모호하다" }],
      parseIssues: ["표 형식 기술 스택"],
    };
    const r = buildReportModel(makeSampleDiagnosis(), makeSampleStages({ outputs: { rescreen } }));
    const html = renderToStaticMarkup(<Report report={r} />);
    expect(html).toContain("여전히 걸리는 이유");
    expect(html).toContain("연차 표기가 여전히 모호하다");
    expect(html).toContain("표 형식 기술 스택");
    expect(html).toContain("개선된 이력서에서 찾지 못했습니다");
  });

  it("요약 머리글에서 액션 버튼이 제목 폭을 줄이지 않는다(shrink-0 옆 배치 금지)", () => {
    const html = renderToStaticMarkup(<Report report={makeSampleReport()} actions={<button>PDF</button>} />);
    const header = html.slice(html.indexOf('id="summary"'), html.indexOf("<button>PDF</button>"));
    expect(header).not.toContain("sm:flex-row");
    expect(header).not.toContain("shrink-0 flex-wrap");
  });
});

describe("parseMarkdownBlocks", () => {
  it("제목·목록·문단을 나눈다", () => {
    const blocks = parseMarkdownBlocks("# 김민준\n연락처\n\n## 경력\n- 하나\n  - 둘\n1. 셋\n\n---\n문단");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "para", "heading", "list", "hr", "para"]);
    const list = blocks[3];
    expect(list.kind === "list" && list.items.map((i) => i.depth)).toEqual([0, 1, 0]);
  });
});
