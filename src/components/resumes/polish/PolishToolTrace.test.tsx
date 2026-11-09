/**
 * 다듬기 답변의 '참고한 자료' 줄: 성공한 호출이 없으면 없음, JD 분석·경험 그래프 n건 요약, 펼치면 호출별 이름·결과.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { polishToolSummary } from "@/lib/domain/resume-polish";
import { PolishToolTrace } from "./PolishToolTrace";

describe("PolishToolTrace", () => {
  it("호출이 없거나 모두 실패면 그리지 않는다", () => {
    expect(renderToStaticMarkup(<PolishToolTrace tools={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<PolishToolTrace tools={[{ tool: "get_node", status: "error", items: 0 }]} />)).toBe("");
  });

  it("JD 분석 · 경험 그래프 n건(접힌 details), 펼치면 호출별 이름·결과", () => {
    const html = renderToStaticMarkup(
      <PolishToolTrace
        tools={[
          { tool: "get_jd_analysis", status: "ok", items: 3 },
          { tool: "search_graph", status: "ok", items: 2 },
          { tool: "get_node", status: "ok", items: 1 },
          { tool: "list_nodes", status: "empty", items: 0 },
        ]}
      />,
    );
    expect(html).toContain("<details");
    expect(html).not.toContain("open");
    expect(html).toContain("참고한 자료: JD 분석 · 경험 그래프 3건");
    expect(html).toContain("경험 그래프 검색 · 2건");
    expect(html).toContain("경험 노드 목록 · 결과 없음");
  });

  it("polishToolSummary: 그래프만·JD만", () => {
    expect(polishToolSummary([{ tool: "search_graph", status: "ok", items: 4 }])).toBe("경험 그래프 4건");
    expect(polishToolSummary([{ tool: "get_jd_analysis", status: "empty", items: 0 }])).toBeNull();
    expect(polishToolSummary([{ tool: "get_jd_analysis", status: "ok", items: 1 }])).toBe("JD 분석");
    // fresh(이 턴에서 처음 본 노드 수)가 있으면 그것으로 센다 — search N1..N3 → get_node N1은 3건.
    expect(
      polishToolSummary([
        { tool: "search_graph", status: "ok", items: 3, fresh: 3 },
        { tool: "get_node", status: "ok", items: 1, fresh: 0 },
      ]),
    ).toBe("경험 그래프 3건");
  });
});
