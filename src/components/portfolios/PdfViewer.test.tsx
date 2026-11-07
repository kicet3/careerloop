import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PdfViewer } from "./PdfViewer";
import { PortfolioOriginalViewer } from "./PortfolioOriginalViewer";

describe("PdfViewer (서버 렌더 첫 화면)", () => {
  it("도구 막대(축소·확대·폭 맞춤·쪽 위치)와 불러오는 중 자리 표시", () => {
    const html = renderToStaticMarkup(<PdfViewer src="/api/p/t/original?viewer=1" downloadHref="/api/p/t/original?download=1" title="포트폴리오 원본" height="60vh" />);
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="포트폴리오 원본 보기 도구"');
    for (const label of ["축소", "확대", "폭에 맞추기"]) expect(html).toContain(`aria-label="${label}"`);
    // 쪽 위치·확대 비율은 보이는 글 앞에 스크린리더용 이름을 붙인다(일반 span의 aria-label은 읽히지 않는다).
    expect(html).toContain('<span class="sr-only">쪽 위치 </span>');
    expect(html).toContain('<span class="sr-only">확대 비율 </span>');
    expect(html).toContain("– / –");
    expect(html).toContain("100%");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("PDF를 불러오는 중");
    expect(html).toContain("height:60vh");
    // 불러오기 전에는 확대 단추를 누를 수 없다.
    expect(html.match(/disabled=""/g)?.length).toBe(3);
  });

  it("PortfolioOriginalViewer: PDF는 iframe 대신 PdfViewer(?viewer=1), 내려받기 링크는 그대로", () => {
    const html = renderToStaticMarkup(
      <PortfolioOriginalViewer src="/api/p/tok/original" fileName="포트폴리오" original={{ mime: "application/pdf", size: 2048, view: "pdf" }} version={5} />,
    );
    expect(html).not.toContain("<iframe");
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('href="/api/p/tok/original?download=1&amp;v=5"');
  });
});
