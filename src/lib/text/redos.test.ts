/**
 * 공백 덩어리·닫지 않은 태그로 정규식·파서가 O(n²)이 되던 경로(공고 페이지, HTML·HWPX 업로드, normalizeText)의 회귀 테스트.
 * 예전 구현은 아래 입력 크기(수십만~수백만 자)에서 수십 초~수십 분이 걸렸다. 선형이면 1초 안팎이다.
 */
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractText, normalizeText } from "@/lib/ingest/extract";
import { htmlText, hwpxSectionText } from "@/lib/ingest/markup";
import { postingPageText } from "@/lib/postings/page-text";
import { collapseWhitespaceKeepLines, trimAroundNewlines, trimLineEnds } from "./whitespace";

/** 넉넉한 상한(CI가 느려도 통과, O(n²)이면 크게 넘는다). */
const BUDGET_MS = 3000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t };
}

describe("공백 정리 함수는 예전 정규식과 같은 결과를 낸다", () => {
  const samples = ["", "a", " a \n b \n\n c ", "x\t \n\t\ny", "\n\n", "a  \nb", "a\r\n b\f\n\n\n c", "  앞 공백\n뒤 공백  "];
  it("trimLineEnds", () => {
    for (const s of samples) expect(trimLineEnds(s)).toBe(s.replace(/[ \t]+$/gm, ""));
  });
  it("trimAroundNewlines", () => {
    for (const s of samples) expect(trimAroundNewlines(s)).toBe(s.replace(/[ \t]*\n[ \t]*/g, "\n"));
  });
  it("collapseWhitespaceKeepLines", () => {
    for (const s of samples) {
      const old = s.replace(/[^\S\n]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
      expect(collapseWhitespaceKeepLines(s)).toBe(old);
    }
  });
});

describe("긴 공백 덩어리·중첩 태그에서도 선형 시간", () => {
  it("공고 페이지: 줄바꿈 없는 \\r 200만 개", () => {
    const html = `<p>a${"\r".repeat(2_000_000)}b</p>`;
    const { value, ms } = timed(() => postingPageText(html));
    expect(value).toBe("a b");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("공고 페이지·HTML 업로드·HWPX: 닫지 않은 태그 수십만 개(파서 스택 깊이 상한)", () => {
    const html = "<span>x".repeat(300_000);
    const page = timed(() => postingPageText(html, 100));
    expect(page.value.startsWith("x")).toBe(true);
    expect(page.ms).toBeLessThan(BUDGET_MS);
    const upload = timed(() => htmlText("<div>".repeat(1_000_000)));
    expect(upload.ms).toBeLessThan(BUDGET_MS);
    const hwpx = timed(() => hwpxSectionText("<a>".repeat(1_000_000)));
    expect(hwpx.ms).toBeLessThan(BUDGET_MS);
  });

  it("보통 깊이의 문서는 끝까지 읽는다", () => {
    const nested = `${"<div>".repeat(100)}<p>깊은 본문</p>${"</div>".repeat(100)}<p>끝</p>`;
    expect(postingPageText(nested)).toBe("깊은 본문\n끝");
  });

  it("공고 페이지: script 안 텍스트는 여전히 버린다", () => {
    expect(postingPageText("<div>본문<script>alert(1)</script><nav><a>메뉴</a></nav>끝</div>")).toBe("본문 끝");
  });

  it("HTML 업로드: <pre> 안 탭 100만 개", async () => {
    const html = `<pre>a${"\t".repeat(1_000_000)}b</pre><p>${"경력 사항을 적은 충분히 긴 문장입니다. ".repeat(5)}</p>`;
    const { value, ms } = timed(() => htmlText(html));
    expect(value.startsWith("\na\t")).toBe(true);
    expect(ms).toBeLessThan(BUDGET_MS);
    const t = performance.now();
    // 상한(maxChars)을 넘긴 뒤로는 모으지 않으므로 결과는 '텍스트가 너무 적음' 거절일 수 있다 — 빨리 끝나기만 하면 된다.
    await extractText({ name: "cv.html", type: "", bytes: strToU8(html) }).catch(() => null);
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
  });

  it("normalizeText: 공백 200만 개 뒤 글자", () => {
    const { value, ms } = timed(() => normalizeText(`${" ".repeat(2_000_000)}y`));
    expect(value).toBe("y");
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it("HWPX: 압축하면 작은 공백 수백만 개 구역도 maxChars에서 멈춘다", async () => {
    const body = `${"이력서 본문 ".repeat(20)}${" ".repeat(8_000_000)}y`;
    const xml = `<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run><hp:t>${body}</hp:t></hp:run></hp:p></hs:sec>`;
    const bytes = zipSync({ "Contents/section0.xml": strToU8(xml) }, { level: 9 });
    expect(bytes.byteLength).toBeLessThan(100_000);
    const t = performance.now();
    const r = await extractText({ name: "cv.hwpx", type: "", bytes });
    expect(performance.now() - t).toBeLessThan(BUDGET_MS);
    expect(r.text.startsWith("이력서 본문")).toBe(true);
  });
});
