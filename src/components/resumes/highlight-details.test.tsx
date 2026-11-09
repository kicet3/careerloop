/**
 * 핵심 성과 = 성과 요약(한 줄) + 상세 성과(줄마다 하나): 구조화 폼·성과 양식 시트·미리보기·텍스트 내보내기,
 * 그리고 예전 문서(context 한 칸)를 읽을 때 상세 성과 줄로 옮기는지.
 * DOM 환경이 없는 프로젝트라 편집 동작은 순수 도우미(parseListText·insertDetailLine·removeDetailLine)와 정적 렌더로 본다.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyResumeDocument, parseResumeDocument, RESUME_SECTION_KEYS, RESUME_TEMPLATE_IDS, type ResumeDocument } from "@/lib/domain/resumes";
import { makeSampleResume } from "@/lib/resumes/__fixtures__/sample";
import { resumeToText } from "@/lib/resumes/layout";
import { highlightDetailRows, insertDetailLine, removeDetailLine } from "./highlight-details";
import { PerformanceSheet } from "./PerformanceSheet";
import { parseListText, ResumeDocumentForm } from "./ResumeDocumentForm";
import { ResumePreview } from "./ResumePreview";

/** 예전 저장본: 핵심 성과에 details가 없고 context 한 칸만 있다. */
function legacyDoc(): ResumeDocument {
  const raw = JSON.parse(JSON.stringify(makeSampleResume())) as Record<string, unknown>;
  raw.highlights = [{ title: "결제 API p95 800ms → 320ms", context: "2023년 결제 API 전체 요청 대상\n캐시 계층을 도입했습니다." }];
  const parsed = parseResumeDocument(raw);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

describe("구조화 폼 — 성과 요약·상세 성과", () => {
  it("상세 성과는 Enter(줄바꿈)마다 하나: 빈 줄은 버리고 줄 수·글자 수 상한으로 자른다", () => {
    expect(parseListText("2023년 대상으로 측정했습니다.\n캐시를 도입했습니다.\n\n  부하 테스트로 검증했습니다.  \n", "lines", 5, 300)).toEqual([
      "2023년 대상으로 측정했습니다.",
      "캐시를 도입했습니다.",
      "부하 테스트로 검증했습니다.",
    ]);
    expect(parseListText("a\nb\nc\nd\ne\nf", "lines", 5, 300)).toEqual(["a", "b", "c", "d", "e"]);
    expect(parseListText("x".repeat(310), "lines", 5, 300)[0]).toHaveLength(300);
  });

  it("'성과 요약' 한 줄 칸과 '상세 성과' 여러 줄 칸(줄마다 하나)을 보인다 — 예전 '측정 기간·핵심 행동' 칸은 없다", () => {
    const doc = emptyResumeDocument();
    doc.highlights = [{ title: "정산 4시간 → 40분", details: ["월말 정산 배치를 대상으로 측정했습니다.", "배치를 병렬화했습니다."], context: "" }];
    const html = renderToStaticMarkup(<ResumeDocumentForm value={doc} onChange={() => {}} sectionOrder={RESUME_SECTION_KEYS} />);
    expect(html).toContain("성과 요약");
    expect(html).toContain("상세 성과");
    expect(html).toContain("한 줄에 하나");
    expect(html).toContain("월말 정산 배치를 대상으로 측정했습니다.\n배치를 병렬화했습니다.</textarea>");
    expect(html).not.toContain("측정 기간·핵심 행동");
  });
});

describe("성과 양식 시트 — 상세 성과 줄", () => {
  it("Enter: 다음 자리에 빈 줄을 넣고 그 줄로 포커스. 줄이 없으면 첫 줄로 포커스만, 5줄이면 더 넣지 않는다", () => {
    expect(insertDetailLine(["a", "b"], 1)).toEqual({ details: ["a", "", "b"], focus: 1 });
    expect(insertDetailLine(["a"], 9)).toEqual({ details: ["a", ""], focus: 1 });
    expect(insertDetailLine([], 0)).toEqual({ details: null, focus: 0 });
    expect(insertDetailLine(["a", "b", "c", "d", "e"], 5)).toBeNull();
  });

  it("빈 줄에서 Backspace: 그 줄을 지우고 앞 줄(첫 줄이면 성과 요약)로", () => {
    expect(removeDetailLine(["a", "", "c"], 1)).toEqual({ details: ["a", "c"], focus: 0 });
    expect(removeDetailLine([""], 0)).toEqual({ details: [], focus: null });
    expect(removeDetailLine([], 0)).toBeNull();
  });

  it("편집 모드: 성과 요약 칸 + 상세 성과 줄마다 칸(접근성 이름 '핵심 성과 N의 상세 성과 M'), 예전 context 칸은 없다", () => {
    const html = renderToStaticMarkup(<PerformanceSheet document={legacyDoc()} onChange={() => {}} />);
    expect(html).toContain('aria-label="핵심 성과 1의 성과 요약"');
    expect(html).toContain('aria-label="핵심 성과 1의 상세 성과 1"');
    expect(html).toContain('aria-label="핵심 성과 1의 상세 성과 2"');
    expect(html).toMatch(/<li[^>]*data-field="highlights\.0\.details\.0"[^>]*>2023년 결제 API 전체 요청 대상<\/li>/);
    expect(html).toMatch(/data-field="highlights\.0\.details\.1"[^>]*>캐시 계층을 도입했습니다\.<\/li>/);
    expect(html).not.toMatch(/data-field="highlights\.\d+\.context"/);
  });

  it("편집 중 상세 성과가 없으면 안내 문구 한 줄(값 아님)을 보인다", () => {
    const doc = emptyResumeDocument();
    doc.highlights = [{ title: "", details: [], context: "" }];
    const html = renderToStaticMarkup(<PerformanceSheet document={doc} onChange={() => {}} />);
    expect(html).toMatch(/data-field="highlights\.0\.details\.0"[^>]*data-empty="\[측정 기간·대상\]에서 \[지표\]를 측정했습니다\."[^>]*><\/li>/);
  });

  it("보기(미리보기·인쇄): 글이 있는 상세 성과 줄만 불릿으로, 없으면 목록도 안내 문구도 없다", () => {
    const doc = emptyResumeDocument();
    doc.highlights = [
      { title: "응답 800ms → 320ms", details: [], context: "" },
      { title: "배포 30분 → 5분", details: ["", "파이프라인을 병렬화했습니다.", "  "], context: "" },
    ];
    const html = renderToStaticMarkup(<PerformanceSheet document={doc} />);
    expect(html).not.toContain("highlights.0.details");
    expect(html).not.toContain("측정했습니다.");
    expect(html).toMatch(/data-field="highlights\.1\.details\.1"[^>]*>파이프라인을 병렬화했습니다\.<\/li>/);
    expect(html).not.toMatch(/data-field="highlights\.1\.details\.(0|2)"/);
    expect(html.match(/pf-highlight-details/g)).toHaveLength(1);
  });

  it("highlightDetailRows: 편집은 모든 줄(없으면 빈 첫 줄), 보기는 글 있는 줄만 — 자리 번호는 그대로", () => {
    expect(highlightDetailRows([], true)).toEqual([{ value: "", index: 0 }]);
    expect(highlightDetailRows([], false)).toEqual([]);
    expect(highlightDetailRows(["a", ""], true)).toEqual([{ value: "a", index: 0 }, { value: "", index: 1 }]);
    expect(highlightDetailRows(["", "b", " "], false)).toEqual([{ value: "b", index: 1 }]);
  });
});

describe("미리보기·텍스트 — 성과 요약 아래 상세 성과 불릿", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s: 예전 문서(context)도 상세 성과 줄로 보인다", (id) => {
    const html = renderToStaticMarkup(<ResumePreview document={legacyDoc()} templateId={id} />);
    expect(html).toContain("결제 API p95 800ms → 320ms");
    expect(html).toContain("2023년 결제 API 전체 요청 대상");
    expect(html).toContain("캐시 계층을 도입했습니다.");
    // 두 줄을 한 칸에 붙여 쓰지 않는다.
    expect(html).not.toContain("2023년 결제 API 전체 요청 대상\n캐시");
  });

  it("텍스트 내보내기: 성과 요약 불릿 아래 상세 성과를 들여 쓴 불릿으로, 성과 요약이 비면 상세 성과만 불릿으로", () => {
    const doc = legacyDoc();
    doc.highlights.push({ title: "", details: ["요약 없는 상세 성과입니다."], context: "" }, { title: "", details: ["  "], context: "" });
    for (const id of RESUME_TEMPLATE_IDS) {
      const text = resumeToText(doc, id);
      expect(text).toContain("## 핵심 성과\n- 결제 API p95 800ms → 320ms\n  - 2023년 결제 API 전체 요청 대상\n  - 캐시 계층을 도입했습니다.\n- 요약 없는 상세 성과입니다.");
    }
  });
});
