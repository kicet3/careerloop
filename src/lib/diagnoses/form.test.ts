import { describe, expect, it } from "vitest";
import { parseDiagnosisForm } from "./form";
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
    const hwp = new File([RESUME], "cv.hwp");
    await expect(parseDiagnosisForm(form({ targetRole: "BE", resumeFile: hwp }))).rejects.toThrow(/^이력서 파일: 지원하지 않는/);
  });
});

describe("contentDisposition", () => {
  it("ASCII 대체 이름 + RFC 5987 UTF-8 이름", () => {
    expect(contentDisposition('보고서 "A/B".pdf', "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent("보고서 A B .pdf")}`,
    );
  });
});
