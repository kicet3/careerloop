import { describe, expect, it } from "vitest";
import { MAX_PORTFOLIO_CHARS, parseDiagnosisForm, PORTFOLIO_NOTE_SEPARATOR } from "./form";
import { contentDisposition } from "./http";

const RESUME = "홍길동\n백엔드 개발자 3년. Kotlin, Spring Boot로 결제 시스템을 운영하며 장애율을 40% 줄였습니다.";

function form(fields: Record<string, string | File>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

describe("parseDiagnosisForm", () => {
  it("붙여넣은 이력서 + JD 파일", async () => {
    const jd = new File(["[자격 요건]\n- Kotlin 3년 이상\n- 대규모 트래픽 경험\n[우대 사항]\n- 결제 도메인"], "jd.txt", {
      type: "text/plain",
    });
    const { input } = await parseDiagnosisForm(
      form({ resumeText: RESUME, targetRole: " 백엔드 개발자 ", jdFile: jd, situation: "bogus", notes: "" }),
    );
    expect(input).toMatchObject({
      resumeText: RESUME,
      resumeFileName: null,
      targetRole: "백엔드 개발자",
      situation: "general",
      notes: null,
    });
    expect(input.jdText).toContain("Kotlin 3년 이상");
  });

  it("이력서 파일만 오면 파일명을 남긴다", async () => {
    const f = new File([RESUME], "resume.md", { type: "text/markdown" });
    const { input } = await parseDiagnosisForm(form({ resumeFile: f, targetRole: "BE", situation: "new_grad" }));
    expect(input.resumeFileName).toBe("resume.md");
    expect(input.jdText).toBeNull();
    expect(input.situation).toBe("new_grad");
  });

  it("직무·이력서 누락, 길이 초과는 한국어 오류", async () => {
    await expect(parseDiagnosisForm(form({ resumeText: RESUME }))).rejects.toThrow("지원 직무");
    await expect(parseDiagnosisForm(form({ targetRole: "BE" }))).rejects.toThrow("이력서 파일을 올리거나");
    await expect(parseDiagnosisForm(form({ targetRole: "BE", resumeText: "a".repeat(40_001) }))).rejects.toThrow(
      "이력서가 너무 깁니다",
    );
    await expect(
      parseDiagnosisForm(form({ targetRole: "BE", resumeText: RESUME, jdText: "가".repeat(30_001) })),
    ).rejects.toThrow("채용 공고가 너무 깁니다");
    const hwp = new File([RESUME], "cv.doc");
    await expect(parseDiagnosisForm(form({ targetRole: "BE", resumeFile: hwp }))).rejects.toThrow(/^이력서 파일: 지원하지 않는/);
  });
});

describe("parseDiagnosisForm — 포트폴리오", () => {
  const PORTFOLIO = "결제 정산 배치 재작성 프로젝트\n- 역할: 백엔드 리드, Kotlin + Spring Batch\n- 결과: 정산 처리 시간 4시간 → 40분";

  it("포트폴리오가 없으면 둘 다 null", async () => {
    const { input } = await parseDiagnosisForm(form({ resumeText: RESUME, targetRole: "BE", portfolioText: "  \n " }));
    expect(input).toMatchObject({ portfolioText: null, portfolioFileName: null });
  });

  it("붙여넣은 링크·설명만", async () => {
    const { input, warnings } = await parseDiagnosisForm(
      form({ resumeText: RESUME, targetRole: "BE", portfolioText: ` ${PORTFOLIO}\r\n` }),
    );
    expect(input.portfolioText).toBe(PORTFOLIO);
    expect(input.portfolioFileName).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("링크만 있으면 경고", async () => {
    const { input, warnings } = await parseDiagnosisForm(
      form({ resumeText: RESUME, targetRole: "BE", portfolioText: "https://github.com/me/payments" }),
    );
    expect(input.portfolioText).toBe("https://github.com/me/payments");
    expect(warnings.join(" ")).toContain("링크는 심사위원이 직접 열어 보지 못합니다");
  });

  it("파일 + 설명은 합치고 파일 이름을 남긴다", async () => {
    const f = new File([PORTFOLIO], "portfolio.md", { type: "text/markdown" });
    const { input } = await parseDiagnosisForm(
      form({ resumeText: RESUME, targetRole: "BE", portfolioFile: f, portfolioText: "https://github.com/me/payments" }),
    );
    expect(input.portfolioFileName).toBe("portfolio.md");
    expect(input.portfolioText).toBe(`${PORTFOLIO}${PORTFOLIO_NOTE_SEPARATOR}https://github.com/me/payments`);
    // 이력서는 그대로
    expect(input.resumeText).toBe(RESUME);
  });

  it("긴 파일은 상한까지 자르고 경고, 긴 설명·지원하지 않는 파일은 거절", async () => {
    const long = new File(["프로젝트 설명 ".repeat(4000)], "long.txt", { type: "text/plain" });
    const { input, warnings } = await parseDiagnosisForm(form({ resumeText: RESUME, targetRole: "BE", portfolioFile: long }));
    expect(input.portfolioText!.length).toBeLessThanOrEqual(MAX_PORTFOLIO_CHARS);
    expect(warnings.join(" ")).toContain("앞부분");

    await expect(
      parseDiagnosisForm(form({ resumeText: RESUME, targetRole: "BE", portfolioText: "가".repeat(5001) })),
    ).rejects.toThrow("포트폴리오 링크·설명은");
    const hwp = new File([PORTFOLIO], "pf.doc");
    await expect(parseDiagnosisForm(form({ resumeText: RESUME, targetRole: "BE", portfolioFile: hwp }))).rejects.toThrow(
      /^포트폴리오 파일: 지원하지 않는/,
    );
  });
});

describe("contentDisposition", () => {
  it("ASCII 대체 이름 + RFC 5987 UTF-8 이름", () => {
    expect(contentDisposition('보고서 "A/B".pdf', "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent("보고서 A B .pdf")}`,
    );
  });
});
