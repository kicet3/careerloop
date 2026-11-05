import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PostingCaptureInfo } from "@/lib/domain/posting-capture";
import { PostingCaptureButton } from "./PostingCapture";
import { SourceLink } from "./SourceLink";

const base: PostingCaptureInfo = { status: "none", capturedAt: null, mime: null, bytes: null, width: null, height: null, error: null, retryable: true };
const render = (info: PostingCaptureInfo | undefined) =>
  renderToStaticMarkup(<PostingCaptureButton apiBase="/api/postings/p1" initial={info} sourceUrl="https://example.com/j/1" title="A · B" />);

describe("PostingCaptureButton 상태", () => {
  it("직접 입력 공고(캡처 정보 없음)는 아무것도 그리지 않는다", () => {
    expect(render(undefined)).toBe("");
  });
  it("done → 원문 캡처 보기", () => {
    const html = render({ ...base, status: "done", capturedAt: 1, mime: "image/webp", width: 1280, height: 900, retryable: false });
    expect(html).toContain("원문 캡처 보기");
    expect(html).toContain('aria-haspopup="dialog"');
  });
  it("pending·running → 캡처 중", () => {
    expect(render({ ...base, status: "running", retryable: false })).toContain("원문 캡처 중");
  });
  it("failed·none → 캡처 없음 · 다시 시도(상한이면 버튼 없음)", () => {
    const failed = render({ ...base, status: "failed", error: "실패" });
    expect(failed).toContain("캡처 없음");
    expect(failed).toContain("다시 시도");
    const maxed = render({ ...base, status: "failed", retryable: false });
    expect(maxed).toContain("캡처 없음");
    expect(maxed).not.toContain("다시 시도");
  });
});

describe("SourceLink", () => {
  it("http/https만 새 탭·noopener noreferrer로", () => {
    const html = renderToStaticMarkup(<SourceLink url="https://example.com/j/1" />);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("원문 공고 열기");
    expect(renderToStaticMarkup(<SourceLink url="javascript:alert(1)" />)).toBe("");
    expect(renderToStaticMarkup(<SourceLink url="" variant="icon" />)).toBe("");
  });
});
