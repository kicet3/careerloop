/**
 * 이력서 PDF의 핵심 성과: 성과 요약 줄 아래 상세 성과(details)를 줄마다 불릿으로 찍는다. 예전 칸 context는 찍지 않는다.
 * react-pdf 기본 요소를 글자만 남기는 가짜로 바꿔, renderResumePdf가 만든 요소 트리의 글을 읽는다(pdf-no-evidence.test.tsx와 같은 방식).
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { parseResumeDocument, RESUME_TEMPLATE_IDS } from "@/lib/domain/resumes";
import { makeSampleResume } from "./__fixtures__/sample";

vi.mock("server-only", () => ({}));

const captured: { el: ReactNode } = { el: null };
vi.mock("@react-pdf/renderer", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;
  return {
    Document: Box,
    Page: Box,
    View: Box,
    Text: ({ children, render }: { children?: ReactNode; render?: unknown }) => (render ? null : <span>{children}</span>),
    Image: Leaf,
    Link: Box,
    StyleSheet: { create: <T,>(s: T) => s },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
    renderToBuffer: async (el: ReactNode) => {
      captured.el = el;
      return Buffer.from("%PDF-");
    },
  };
});

describe("PDF — 핵심 성과 상세 성과 불릿", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s: 성과 요약 다음에 상세 성과가 줄마다 불릿으로 나온다", async (id) => {
    const { renderResumePdf } = await import("./pdf");
    const doc = makeSampleResume();
    doc.highlights = [{ title: "결제 API p95 800ms → 320ms", details: ["2023년 전체 요청 대상으로 측정했습니다.", "  ", "캐시 계층을 도입했습니다."], context: "예전 칸 값" }];
    await renderResumePdf(doc, id);
    const html = renderToStaticMarkup(<>{captured.el}</>);
    const title = html.indexOf("결제 API p95 800ms → 320ms");
    const first = html.indexOf("2023년 전체 요청 대상으로 측정했습니다.");
    const second = html.indexOf("캐시 계층을 도입했습니다.");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(title);
    expect(second).toBeGreaterThan(first);
    // 두 상세 성과 사이에 불릿 기호가 있다(줄마다 불릿).
    expect(html.slice(first, second)).toContain("•");
    expect(html).not.toContain("예전 칸 값");
  });

  it("예전 문서(context 한 칸)는 읽을 때 상세 성과 줄로 옮겨져 불릿으로 찍힌다", async () => {
    const { renderResumePdf } = await import("./pdf");
    const raw = JSON.parse(JSON.stringify(makeSampleResume())) as Record<string, unknown>;
    raw.highlights = [{ title: "정산 4시간 → 40분", context: "월말 정산 배치 대상\n배치를 병렬화했습니다." }];
    const parsed = parseResumeDocument(raw);
    expect(parsed.success).toBe(true);
    await renderResumePdf(parsed.data!, "performance");
    const html = renderToStaticMarkup(<>{captured.el}</>);
    const a = html.indexOf("월말 정산 배치 대상");
    const b = html.indexOf("배치를 병렬화했습니다.");
    expect(a).toBeGreaterThan(html.indexOf("정산 4시간 → 40분"));
    expect(html.slice(a, b)).toContain("•");
  });
});
