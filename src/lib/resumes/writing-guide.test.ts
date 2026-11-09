import { describe, expect, it } from "vitest";
import { EMPTY_RESUME_ITEM, emptyResumeDocument } from "@/lib/domain/resumes";
import { RESUME_WRITING_CRITERIA_PROMPT, resumeTipSignals, SUBMIT_CHECKLIST } from "./writing-guide";

describe("이력서 작성 팁 신호", () => {
  it("빈 문서는 첫 화면 4요소가 모두 비어 있다", () => {
    const s = resumeTipSignals(emptyResumeDocument());
    expect(s.firstScreen).toEqual({ headline: false, highlight: false, experience: false, project: false });
    expect(s.vagueLines).toEqual([]);
  });

  it("채운 항목·모호한 문장·맥락 없는 숫자·[ADD] 자리표시를 찾는다", () => {
    const d = emptyResumeDocument();
    d.basics.headline = "데이터 분석가";
    d.highlights = [{ title: "전환율 10% → 12%", details: ["[ADD: 측정 기간]"], context: "" }];
    d.experience = [{ ...EMPTY_RESUME_ITEM.experience(), company: "A사", startDate: "2022.01", bullets: ["주간 리포트 작성 담당", "대시보드 구축으로 조회 시간 30% 단축", "2023년 1분기 고객 1,200명 대상 실험으로 이탈 5% 감소"] }];
    d.projects = [{ ...EMPTY_RESUME_ITEM.project(), name: "추천 개편", result: "클릭률 상승" }];
    const s = resumeTipSignals(d);
    expect(s.firstScreen).toEqual({ headline: true, highlight: true, experience: true, project: true });
    expect(s.vagueLines).toEqual(["주간 리포트 작성 담당"]);
    expect(s.numberLinesWithoutContext).toContain("대시보드 구축으로 조회 시간 30% 단축");
    expect(s.numberLinesWithoutContext).not.toContain("2023년 1분기 고객 1,200명 대상 실험으로 이탈 5% 감소");
    expect(s.addPlaceholders).toBe(1);
  });

  it("[ADD]만 있는 칸은 채운 것으로 치지 않는다", () => {
    const d = emptyResumeDocument();
    d.basics.headline = "[ADD: 지원 직무]";
    expect(resumeTipSignals(d).firstScreen.headline).toBe(false);
  });

  it("체크리스트 12개(id 고유), 프롬프트 기준은 지어내지 않기를 앞세운다", () => {
    expect(SUBMIT_CHECKLIST).toHaveLength(12);
    expect(new Set(SUBMIT_CHECKLIST.map((c) => c.id)).size).toBe(12);
    expect(RESUME_WRITING_CRITERIA_PROMPT).toContain("지어내지 않고");
    expect(RESUME_WRITING_CRITERIA_PROMPT).toContain("%p");
  });
});
