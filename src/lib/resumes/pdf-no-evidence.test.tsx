/**
 * 이력서 PDF에 프로젝트 근거 줄('근거: …')을 찍지 않는다 — 예전 문서에 evidence 값이 남아 있어도.
 * react-pdf 기본 요소를 글자만 남기는 가짜로 바꿔, renderResumePdf가 만든 요소 트리의 글을 읽는다.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RESUME_TEMPLATE_IDS } from "@/lib/domain/resumes";
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

describe("PDF — 프로젝트 근거 줄 없음", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s: evidence 값이 있는 예전 문서도 '근거:'와 그 값을 찍지 않는다", async (id) => {
    const { renderResumePdf } = await import("./pdf");
    const doc = makeSampleResume();
    doc.projects = doc.projects.map((p) => ({ ...p, evidence: "사내 정산 대시보드 근거자료" }));
    await renderResumePdf(doc, id);
    const html = renderToStaticMarkup(<>{captured.el}</>);
    expect(html).toContain(doc.projects[0]!.name);
    expect(html).not.toContain("근거:");
    expect(html).not.toContain("근거자료");
  });
});
