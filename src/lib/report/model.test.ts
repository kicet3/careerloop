import { describe, expect, it, vi } from "vitest";

// 워크스트림 A의 verifyQuote와 독립적으로 테스트하기 위해 단순 부분 일치로 대체한다.
vi.mock("@/lib/panel/quotes", () => ({
  verifyQuote: (resume: string, quote: string) => {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    return norm(resume).includes(norm(quote));
  },
}));

import { buildReportModel } from "./model";
import { renderPanelMarkdown, renderResumeMarkdown } from "./markdown";
import {
  SAMPLE_OUTPUTS,
  makeSampleDiagnosis,
  makeSampleReport,
  makeSampleStages,
} from "./__fixtures__/sample";

describe("buildReportModel — 전체 데이터", () => {
  const r = makeSampleReport();

  it("메타데이터와 요약을 채운다", () => {
    expect(r.meta.title).toBe("머니브릿지 결제 백엔드 지원");
    expect(r.meta.situationLabel).toBe("일반 지원");
    expect(r.meta.hasJd).toBe(true);
    expect(r.summary.headline).toBe(SAMPLE_OUTPUTS.synthesis.headline);
    expect(r.summary.totalReviewers).toBe(7);
    // gatekeeper INTERVIEW + teammate HIRE (ATS REJECT, 리더 PASS는 거절)
    expect(r.summary.positiveCount).toBe(2);
    expect(r.summary.matchScore).toBe(58);
    expect(r.summary.atsBefore).toEqual({ raw: "REJECT", label: "탈락", tone: "negative" });
    expect(r.summary.atsAfter).toEqual({ raw: "PASS", label: "통과", tone: "positive" });
  });

  it("심사위원 카드를 표시 순서대로 만들고 리더의 PASS를 거절로 표시한다", () => {
    expect(r.reviewers.map((c) => c.id)).toEqual(["ats", "gatekeeper", "manager", "rival", "ceo", "recruiter", "teammate"]);
    const rival = r.reviewers.find((c) => c.id === "rival")!;
    expect(rival.verdict).toEqual({ raw: "PASS", label: "거절", tone: "negative" });
  });

  it("인용을 원문과 대조한다", () => {
    const rival = r.reviewers.find((c) => c.id === "rival")!;
    expect(rival.detail.kind === "reader" && rival.detail.worstLine.quote.verified).toBe(false);
    const ceo = r.reviewers.find((c) => c.id === "ceo")!;
    expect(ceo.detail.kind === "reader" && ceo.detail.worstLine.quote.verified).toBe(true);
    const ats = r.reviewers[0];
    expect(ats.detail.kind === "ats" && ats.detail.reasons.every((x) => x.quote.verified)).toBe(true);
  });

  it("적합도 행은 필수 → 우대 순서로 요건과 결과를 잇는다", () => {
    expect(r.jd).not.toBeNull();
    const rows = r.jd!.rows;
    expect(rows.map((x) => x.requirement.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
    expect(rows.map((x) => x.priority)).toEqual(["must", "must", "must", "must", "nice", "nice", "nice"]);
    expect(rows[0].evidence).toEqual({ text: "(주)바른커머스 — 백엔드 개발자 (2022.03 ~ 현재)", verified: true });
    expect(rows[3].evidence).toBeNull();
    expect(r.jd!.counts).toEqual({ met: 1, partial: 2, missing: 4 });
  });

  it("문제점을 rank 순으로 정렬하고 심사위원 이름을 붙인다", () => {
    expect(r.mistakes.map((m) => m.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.mistakes[0].flaggedBy).toEqual([
      { id: "ats", name: "서류 자동 필터" },
      { id: "rival", name: "경쟁 지원자" },
    ]);
    expect(r.mistakes[4].quote).toBeNull();
  });

  it("재작성에 재심사 결과를 붙인다", () => {
    expect(r.rewrite?.rescreen?.verdict).toBe("PASS");
    expect(r.plan?.priorities).toHaveLength(3);
    expect(r.originalResume).toContain("김민준");
  });
});

describe("buildReportModel — 부분 데이터", () => {
  it("아무 단계도 없으면 빈 보고서와 '미완료' ATS를 만든다", () => {
    const r = buildReportModel(makeSampleDiagnosis(), []);
    expect(r.reviewers).toEqual([]);
    expect(r.summary.positiveCount).toBe(0);
    expect(r.summary.atsBefore).toMatchObject({ label: "미완료", tone: "neutral" });
    expect(r.summary.atsAfter).toBeNull();
    expect(r.summary.headline).toContain("끝나지 않아");
    expect(r.jd).toBeNull();
    expect(r.mistakes).toEqual([]);
    expect(r.plan).toBeNull();
    expect(r.rewrite).toBeNull();
  });

  it("fit 없이 jd만 있으면 행의 item이 null이고 개수는 0이다", () => {
    const r = buildReportModel(makeSampleDiagnosis(), makeSampleStages({ omit: ["fit", "synthesis", "rewrite", "plan", "rescreen"] }));
    expect(r.jd!.rows.every((x) => x.item === null && x.evidence === null)).toBe(true);
    expect(r.jd!.counts).toEqual({ met: 0, partial: 0, missing: 0 });
    expect(r.summary.matchScore).toBeNull();
    expect(r.summary.headline).toContain("7명 중 2명");
  });

  it("스키마에 맞지 않거나 완료되지 않은 단계는 무시한다", () => {
    const stages = makeSampleStages();
    const ats = stages.find((s) => s.stage === "ats")!;
    ats.output = { verdict: "MAYBE" };
    const ceo = stages.find((s) => s.stage === "ceo")!;
    ceo.status = "failed";
    const r = buildReportModel(makeSampleDiagnosis(), stages);
    expect(r.reviewers.map((c) => c.id)).not.toContain("ats");
    expect(r.reviewers.map((c) => c.id)).not.toContain("ceo");
    expect(r.summary.atsBefore.label).toBe("미완료");
  });

  it("문자열로 저장된 JSON 출력도 읽는다", () => {
    const stages = makeSampleStages();
    const fit = stages.find((s) => s.stage === "fit")!;
    fit.output = JSON.stringify(fit.output);
    expect(buildReportModel(makeSampleDiagnosis(), stages).summary.matchScore).toBe(58);
  });

  it("rewrite가 있고 rescreen이 없으면 rescreen은 null", () => {
    const r = buildReportModel(makeSampleDiagnosis(), makeSampleStages({ omit: ["rescreen"] }));
    expect(r.rewrite?.rescreen).toBeNull();
    expect(r.summary.atsAfter).toBeNull();
  });

  it("JD 원문이 없으면 hasJd=false", () => {
    expect(buildReportModel(makeSampleDiagnosis({ jdText: "  " }), []).meta.hasJd).toBe(false);
  });
});

describe("markdown", () => {
  const r = makeSampleReport();

  it("PANEL.md에 판정·매트릭스·문제점·개선 방향성과 크레딧을 담는다", () => {
    const md = renderPanelMarkdown(r);
    expect(md).toContain("**경쟁 지원자** — 거절 (PASS)");
    expect(md).toContain("| R4 | 필수 · 경력 | AWS 등 클라우드 운영 경험 | 미충족 |");
    expect(md).toContain("1. **공고 핵심 키워드(AWS·Kafka·트래픽 규모)가 빠져 서류 필터에서 탈락** [치명적]");
    expect(md).toContain("## 개선 방향성");
    expect(md).toContain("- [ ] '- 다양한 업무 수행' 줄을 삭제한다.");
    expect(md).toContain("(원문에서 찾지 못함)");
    expect(md.trimEnd().endsWith("원본: /hiring-panel by Alex Chen (@nocodealex) · MIT")).toBe(true);
  });

  it("표 셀의 파이프를 이스케이프한다", () => {
    const md = renderPanelMarkdown(r);
    const tableLines = md.split("\n").filter((l) => l.startsWith("| R1 "));
    expect(tableLines[0].split(/(?<!\\)\|/).length).toBe(8);
  });

  it("RESUME-IMPROVED.md에 이력서·[ADD] 질문·추정·크레딧을 담는다", () => {
    const md = renderResumeMarkdown(r);
    expect(md.startsWith("# 김민준")).toBe(true);
    expect(md).toContain("## 채워야 할 정보 ([ADD])");
    expect(md).toContain("1. 결제 API가 처리한 일 평균 결제 건수와 피크 TPS는 얼마였나요?");
    expect(md).toContain("## 추정한 내용");
    expect(md).toContain("서류 자동 필터: 탈락 → 통과");
    expect(md.trimEnd().endsWith("원본: /hiring-panel by Alex Chen (@nocodealex) · MIT")).toBe(true);
  });

  it("부분 보고서도 렌더링한다", () => {
    const partial = buildReportModel(makeSampleDiagnosis(), makeSampleStages({ omit: ["jd", "synthesis", "rewrite", "plan", "rescreen", "ceo"] }));
    const panel = renderPanelMarkdown(partial);
    expect(panel).toContain("**대표** — 미완료");
    expect(panel).toContain("JD 분석이 완료되지 않았습니다.");
    expect(renderResumeMarkdown(partial)).toContain("이력서 재작성이 완료되지 않았습니다.");
  });
});
