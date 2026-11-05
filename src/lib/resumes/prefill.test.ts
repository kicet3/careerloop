import { describe, expect, it } from "vitest";
import {
  MAX_PREFILL_PORTFOLIO_CHARS,
  prefillPortfolioFileName,
  saveDiagnosisPrefill,
  saveDraftNotes,
  takeDiagnosisPrefill,
  takeDraftNotes,
} from "./prefill";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    size: () => m.size,
  };
}

describe("진단 프리필", () => {
  it("저장한 값을 한 번만 읽는다", () => {
    const s = memoryStore();
    expect(saveDiagnosisPrefill({ resumeText: "# 홍길동", targetRole: "백엔드", jdText: "JD" }, s, 1000)).toBe(true);
    expect(takeDiagnosisPrefill(s, 2000)).toEqual({ resumeText: "# 홍길동", targetRole: "백엔드", jdText: "JD" });
    expect(takeDiagnosisPrefill(s, 2000)).toBeNull();
    expect(s.size()).toBe(0);
  });

  it("오래됐거나 형식이 틀리면 null", () => {
    const s = memoryStore();
    saveDiagnosisPrefill({ resumeText: "x", targetRole: "", jdText: "" }, s, 0);
    expect(takeDiagnosisPrefill(s, 11 * 60_000)).toBeNull();
    s.setItem("rp:new-diagnosis-prefill", "{not json");
    expect(takeDiagnosisPrefill(s)).toBeNull();
    s.setItem("rp:new-diagnosis-prefill", JSON.stringify({ resumeText: 1, at: Date.now() }));
    expect(takeDiagnosisPrefill(s)).toBeNull();
    expect(takeDiagnosisPrefill(null)).toBeNull();
  });
});

describe("초안 메모", () => {
  it("이력서 id별로 한 번만", () => {
    const s = memoryStore();
    saveDraftNotes("r1", { notes: ["a"], missingInfo: ["b?"] }, s);
    saveDraftNotes("r2", { notes: [], missingInfo: [] }, s);
    expect(takeDraftNotes("r2", s)).toBeNull();
    expect(takeDraftNotes("r1", s)).toEqual({ notes: ["a"], missingInfo: ["b?"] });
    expect(takeDraftNotes("r1", s)).toBeNull();
  });
});

describe("진단 프리필: 이력서 첨부 포트폴리오", () => {
  it("포트폴리오 글·파일 이름·링크를 넘기고 글은 상한까지만 담는다", () => {
    const s = memoryStore();
    const long = "가".repeat(MAX_PREFILL_PORTFOLIO_CHARS + 50);
    saveDiagnosisPrefill(
      { resumeText: "# 홍길동", targetRole: "백엔드", jdText: "", portfolioText: long, portfolioFileName: "포트폴리오.pdf", portfolioUrl: "https://me.dev/p" },
      s,
      1000,
    );
    const got = takeDiagnosisPrefill(s, 2000)!;
    expect(got.portfolioText!.length).toBe(MAX_PREFILL_PORTFOLIO_CHARS);
    expect(got.portfolioFileName).toBe("포트폴리오.pdf");
    expect(got.portfolioUrl).toBe("https://me.dev/p");
  });

  it("http/https가 아닌 링크·빈 글은 버린다", () => {
    const s = memoryStore();
    saveDiagnosisPrefill({ resumeText: "x", targetRole: "", jdText: "", portfolioText: "  ", portfolioUrl: "javascript:alert(1)" }, s, 1000);
    const got = takeDiagnosisPrefill(s, 2000)!;
    expect(got.portfolioText).toBeUndefined();
    expect(got.portfolioUrl).toBeUndefined();
    s.setItem("rp:new-diagnosis-prefill", JSON.stringify({ resumeText: "x", portfolioUrl: "data:text/html,hi", at: 1000 }));
    expect(takeDiagnosisPrefill(s, 2000)!.portfolioUrl).toBeUndefined();
  });

  it("진단 폼에 올릴 .txt 파일 이름", () => {
    expect(prefillPortfolioFileName("포트폴리오.pdf")).toBe("포트폴리오.pdf.txt");
    expect(prefillPortfolioFileName("notes.TXT")).toBe("notes.TXT");
    expect(prefillPortfolioFileName(undefined)).toBe("portfolio.txt");
    expect(prefillPortfolioFileName("a/b\\c")).toBe("a b c.txt");
  });
});
