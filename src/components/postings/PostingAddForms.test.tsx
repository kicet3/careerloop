import { renderToStaticMarkup } from "react-dom/server";
import type { PostingImportJob } from "@/lib/domain/postings";
import { describe, expect, it, vi } from "vitest";
import { ExploreAddPanel, ExploreView } from "./ExploreView";
import { PostingAddForms } from "./PostingAddForms";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const start = vi.fn();

describe("PostingAddForms(보관함 '직접 추가'·공고 찾기 '공고 추가' 공용 입력)", () => {
  it("AI 엔진이 있으면 원문 붙여넣기(AI로 추가)가 기본이고 직접 입력은 펼쳐 쓴다", () => {
    const html = renderToStaticMarkup(<PostingAddForms aiAvailable start={start} onPasteStarted={() => {}} onCancel={() => {}} />);
    expect(html).toContain("AI로 추가하기");
    expect(html).toContain("공고 원문 붙여넣기");
    expect(html).toContain("직접 입력(항목을 하나씩 적기)");
  });
  it("AI 엔진이 없으면 직접 입력 폼만", () => {
    const html = renderToStaticMarkup(<PostingAddForms aiAvailable={false} start={start} onPasteStarted={() => {}} onCancel={() => {}} />);
    expect(html).not.toContain("AI로 추가하기");
    expect(html).not.toContain("<details");
    expect(html).toContain('id="pf-company"');
  });
});

describe("ExploreView '공고 추가'", () => {
  it("오른쪽 위에 닫힌 '공고 추가' 버튼이 있고, 입력 칸은 누르기 전에는 그리지 않는다", () => {
    const html = renderToStaticMarkup(<ExploreView initial={{ items: [], total: 0 }} serverNow={0} aiAvailable />);
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>공고 추가<\/button>/);
    expect(html).not.toContain("explore-add-panel");
    expect(html).not.toContain("링크로 가져오기");
  });
  it("진행 중인 가져오기가 있으면 버튼에 개수를 보인다", () => {
    const html = renderToStaticMarkup(
      <ExploreView
        initial={{ items: [], total: 0 }}
        serverNow={0}
        initialImports={[{ id: "j1", url: "https://example.com/j/1", status: "analyzing", error: null, errorCode: null, postingId: null, sharedPostingId: null, refresh: false, createdAt: 0, updatedAt: 0 } satisfies PostingImportJob]}
      />,
    );
    expect(html).toContain("공고 추가 (가져오는 중 1)");
  });
});

describe("ExploreAddPanel(공고 찾기 '공고 추가' 패널 본문)", () => {
  const job = (over: Partial<PostingImportJob>): PostingImportJob => ({
    id: "j1",
    url: "https://example.com/j/1",
    status: "analyzing",
    error: null,
    errorCode: null,
    postingId: null,
    sharedPostingId: null,
    refresh: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });
  const panel = (jobs: PostingImportJob[], aiAvailable = true) =>
    renderToStaticMarkup(
      <ExploreAddPanel aiAvailable={aiAvailable} imports={{ jobs, start, dismiss: () => {} }} onCancel={() => {}} onPasteStarted={() => {}} />,
    );

  it("보관함 안내 링크·링크로 가져오기 입력·원문 붙여넣기·직접 입력을 함께 그린다", () => {
    const html = panel([]);
    expect(html).toContain('id="explore-add-panel"');
    expect(html).toMatch(/href="\/app\/postings"[^>]*>내 보관함<\/a>/);
    expect(html).toContain("링크로 가져오기");
    expect(html).toContain("AI로 추가하기");
    expect(html).toContain("직접 입력(항목을 하나씩 적기)");
  });
  it("AI 엔진이 없으면 원문 붙여넣기 없이 직접 입력 폼", () => {
    const html = panel([], false);
    expect(html).not.toContain("AI로 추가하기");
    expect(html).toContain('id="pf-company"');
  });
  it("진행 중 작업은 진행 카드(공고 찾기 안내 문구)로, 끝난 작업은 완료 줄과 보관함 열기 링크로 보인다", () => {
    const html = panel([job({ id: "a", status: "analyzing" }), job({ id: "b", status: "completed", postingId: "p1" })]);
    expect(html).toContain("끝나면 위에 &#x27;추가 완료&#x27;로 표시되고 내 보관함에 들어갑니다");
    expect(html).toMatch(/href="\/app\/postings\/p1"[^>]*>열기<\/a>/);
  });
  it("실패한 작업은 실패 줄로 보인다(이미 보관한 공고면 기존 공고 링크)", () => {
    const html = panel([job({ status: "failed", error: "이미 보관한 공고입니다.", postingId: "p9" })]);
    expect(html).toContain("이미 보관한 공고입니다.");
    expect(html).toMatch(/href="\/app\/postings\/p9"[^>]*>기존 공고<\/a>/);
  });
});
