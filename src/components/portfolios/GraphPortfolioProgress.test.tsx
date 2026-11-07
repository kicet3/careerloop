import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GraphPortfolioJobView } from "@/lib/domain/graph-portfolio";
import { GraphPortfolioProgress, graphPortfolioHeading } from "./GraphPortfolioProgress";
import { PortfolioSheet, sheetAtoms } from "./PortfolioSheet";
import { parseMarkdownBlocks } from "@/components/report/MiniMarkdown";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/app/portfolios" }));

const job = (over: Partial<GraphPortfolioJobView> = {}): GraphPortfolioJobView => ({
  id: "j1",
  status: "running",
  stage: "writing",
  label: "백엔드 포트폴리오",
  error: null,
  portfolioId: null,
  regenerate: false,
  notes: [],
  missingInfo: [],
  canRetry: false,
  attempts: 1,
  startedAt: 1000,
  createdAt: 1000,
  updatedAt: 1000,
  completedAt: null,
  ...over,
});

describe("GraphPortfolioProgress", () => {
  it("제목은 상태·다시 만들기에 맞춘다", () => {
    expect(new Set(["running", "failed", "completed"].flatMap((s) => [false, true].map((r) => graphPortfolioHeading({ status: s as GraphPortfolioJobView["status"], regenerate: r })))).size).toBe(5);
  });

  it("진행 중: 단계와 '떠나도 계속' 안내", () => {
    const html = renderToStaticMarkup(<GraphPortfolioProgress initialJob={job()} />);
    for (const label of ["자료 모음", "AI가 포트폴리오 쓰는 중", "저장 중", "완료"]) expect(html).toContain(label);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("이 화면을 떠나도");
  });

  it("실패: 문구와 다시 시도(입력이 남았을 때만)", () => {
    const html = renderToStaticMarkup(<GraphPortfolioProgress initialJob={job({ status: "failed", error: "거절됨", canRetry: true })} />);
    expect(html).toContain("거절됨");
    expect(html).toContain("다시 시도");
    expect(renderToStaticMarkup(<GraphPortfolioProgress initialJob={job({ status: "failed", error: "x" })} />)).not.toContain("다시 시도");
  });

  it("완료: 포트폴리오 열기 링크", () => {
    const html = renderToStaticMarkup(<GraphPortfolioProgress initialJob={job({ status: "completed", portfolioId: "pf1" })} autoOpen={false} />);
    expect(html).toContain('href="/app/portfolios/pf1"');
  });
});

describe("PortfolioSheet", () => {
  it("제목(h2·h3)과 구분선은 다음 블록과 함께 넘긴다", () => {
    const blocks = parseMarkdownBlocks("# 제목\n\n---\n\n## 1. 프로젝트\n\n### 개요\n\n본문\n\n- 성과");
    const atoms = sheetAtoms(blocks, blocks.map(() => ({ height: 10, gapBefore: 2 })));
    expect(atoms.map((a) => a.keepWithNext)).toEqual([false, true, true, true, false, false]);
  });

  it("HTML을 주입하지 않고 그린다(링크는 http/https만)", () => {
    const html = renderToStaticMarkup(<PortfolioSheet source={"# 제목\n\n<script>x</script> [나쁜](javascript:alert(1)) [좋은](https://a.dev)\n\n- [ADD: 팀 규모]"} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://a.dev"');
    expect(html).toContain("[ADD: 팀 규모]</mark>");
  });
});
