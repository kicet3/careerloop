import { describe, expect, it } from "vitest";
import { safeSourceUrl, sourceHostLabel } from "./source-link";

describe("공고 원문 링크", () => {
  it("http/https만 허용한다", () => {
    expect(safeSourceUrl(" https://www.wanted.co.kr/wd/1 ")).toBe("https://www.wanted.co.kr/wd/1");
    expect(safeSourceUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://x.com", "//x.com", "x.com", "", null, undefined, "https://u:p@x.com"]) {
      expect(safeSourceUrl(bad)).toBeNull();
    }
  });

  it("호스트 표시", () => {
    expect(sourceHostLabel("https://www.saramin.co.kr/a")).toBe("saramin.co.kr");
    expect(sourceHostLabel("javascript:x")).toBe("");
  });
});
