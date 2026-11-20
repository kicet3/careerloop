import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ResumeAgentJobView } from "@/lib/resume-agent/job-types";
import { AGENT_POLL_MS, AGENT_POLL_SLOW_MS, agentPollMs, AgentProgress, agentStatusMessage } from "./AgentProgress";
import { AgentReport, changeSectionLabel, lineStillPresent, motivationNotice, reportHeadline } from "./AgentReport";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const job = (over: Partial<ResumeAgentJobView> = {}): ResumeAgentJobView => ({
  id: "j1",
  mode: "agent",
  status: "running",
  label: "토스 · 백엔드",
  currentStep: "r0.review",
  steps: [
    { key: "r0.jd", kind: "jd", round: 0, status: "done", summary: ["필수 7 · 우대 4 · 키워드 18"], error: null, startedAt: 1, finishedAt: 2 },
    { key: "r0.review", kind: "review", round: 0, status: "running", summary: [], error: null, startedAt: 3, finishedAt: null },
    { key: "finalize", kind: "finalize", round: -1, status: "pending", summary: [], error: null, startedAt: null, finishedAt: null },
  ],
  rounds: [{ round: 0, passCount: 1, passTotal: 3, matchScore: 62, panelScore: 45, atsPass: false, incomplete: false, verdicts: [{ reviewer: "manager", verdict: "PASS", positive: false, oneLiner: "" }, { reviewer: "ats", verdict: "PASS", positive: true, oneLiner: "" }] }],
  finalPanel: null,
  coverage: { mustFound: 6, mustTotal: 7, niceFound: 3, niceTotal: 4 },
  stopReason: null,
  error: null,
  errorCode: null,
  failedStep: null,
  canRetry: false,
  canFallback: false,
  needsKick: false,
  chainEnabled: true,
  resumeId: null,
  previewText: "## 요약\n주문 시스템",
  attempts: 1,
  startedAt: 1000,
  createdAt: 1000,
  updatedAt: 1000,
  completedAt: null,
  ...over,
});

describe("AgentProgress", () => {
  it("단계 요약·라운드 점수표(리더 PASS는 거절)·미리 보기·취소", () => {
    const html = renderToStaticMarkup(<AgentProgress initialJob={job()} />);
    expect(html).toContain("필수 7 · 우대 4 · 키워드 18");
    expect(html).toContain("초안 심사");
    expect(html).toContain("팀장 거절");
    expect(html).toContain("서류 자동 필터 통과");
    expect(html).toContain("1/3");
    expect(html).toContain("가장 좋은 초안 미리 보기");
    expect(html).toContain("취소");
    expect(html).toContain("보통 8~15분");
  });

  it("§4.4 상태 문구: 대기(연쇄 있음/없음)·그래프 부족·입력 만료·예산·심사 미완료·목표 미달", () => {
    expect(agentStatusMessage({ status: "waiting", chainEnabled: true, errorCode: null, canRetry: false, stopReason: null })).toContain("화면을 닫아도 이어서");
    expect(agentStatusMessage({ status: "waiting", chainEnabled: false, errorCode: null, canRetry: false, stopReason: null })).toContain("열어 두면 더 빨리");
    expect(agentStatusMessage({ status: "failed", chainEnabled: true, errorCode: "insufficient_graph", canRetry: false, stopReason: null })).toContain("그래프 채팅");
    expect(agentStatusMessage({ status: "failed", chainEnabled: true, errorCode: "step_failed", canRetry: false, stopReason: null })).toContain("만료");
    expect(agentStatusMessage({ status: "failed", chainEnabled: true, errorCode: "schema_version", canRetry: true, stopReason: null })).toContain("업데이트");
    expect(agentStatusMessage({ status: "completed", chainEnabled: true, errorCode: null, canRetry: false, stopReason: "budget" })).toContain("비용 상한");
    expect(agentStatusMessage({ status: "completed", chainEnabled: true, errorCode: null, canRetry: false, stopReason: "review_failed" })).toContain("진단에서");
    expect(agentStatusMessage({ status: "completed", chainEnabled: true, errorCode: null, canRetry: false, stopReason: "plateau" })).toContain("목표 기준");
    expect(agentStatusMessage({ status: "canceled", chainEnabled: true, errorCode: null, canRetry: false, stopReason: null })).toBe("취소했습니다.");
  });

  it("실패 화면: 실패한 단계부터 다시·빠른 초안·그래프 채팅 링크", () => {
    const html = renderToStaticMarkup(<AgentProgress initialJob={job({ status: "failed", canRetry: true, canFallback: true, error: "거절" })} />);
    expect(html).toContain("실패한 단계부터 다시");
    expect(html).toContain("빠른 초안으로 만들기");
    const g = renderToStaticMarkup(<AgentProgress initialJob={job({ status: "failed", canFallback: true, errorCode: "insufficient_graph" })} />);
    expect(g).toContain("/app/graph?ask=");
    expect(g).not.toContain("실패한 단계부터 다시");
  });

  it("폴링 간격: 2초 → 30초 뒤 5초, 실패할수록 늘림", () => {
    expect(agentPollMs(0, 0)).toBe(AGENT_POLL_MS);
    expect(agentPollMs(31_000, 0)).toBe(AGENT_POLL_SLOW_MS);
    expect(agentPollMs(0, 2)).toBe(AGENT_POLL_MS * 4);
  });
});

describe("AgentProgress v2(구역별 에이전트)", () => {
  const v2 = (): Partial<ResumeAgentJobView> => ({
    pipelineVersion: 2,
    currentStep: "r1.sec.experience",
    steps: [
      { key: "r0.jd", kind: "jd", round: 0, status: "done", summary: ["저장된 JD 분석을 사용했습니다(진단 2026.11.02)"], error: null, startedAt: 1, finishedAt: 2 },
      { key: "r0.brief", kind: "brief", round: 0, status: "done", summary: ["구역 배정: 경력 2 · 대표 프로젝트 1 · 목표 2쪽"], error: null, startedAt: 2, finishedAt: 3 },
      { key: "r0.sections", kind: "section", round: 0, status: "done", summary: ["경력 완료 · 대표 프로젝트 완료"], error: null, startedAt: null, finishedAt: null },
      { key: "r0.compose", kind: "compose", round: 0, status: "done", summary: [], error: null, startedAt: 3, finishedAt: 4 },
      { key: "r0.review", kind: "review", round: 0, status: "done", summary: [], error: null, startedAt: 4, finishedAt: 5 },
      { key: "r0.critique", kind: "critique", round: 0, status: "done", summary: ["다시 쓸 구역: 경력"], error: null, startedAt: 5, finishedAt: 6 },
      { key: "r1.sections", kind: "section", round: 1, status: "running", summary: ["경력 작성 중"], error: null, startedAt: null, finishedAt: null },
    ],
    sections: [
      { section: "experience", label: "경력", skipped: false, rounds: [{ round: 0, status: "done", summary: ["R1·R2 담당 · 회사 1개 · 3줄 · 인용 100%"], score: 55, fallback: false }, { round: 1, status: "running", summary: [], score: null, fallback: false }] },
      { section: "highlights", label: "핵심 성과", skipped: false, rounds: [{ round: 0, status: "done", summary: [], score: 80, fallback: false }, { round: 1, status: "kept", summary: ["총괄이 그대로 두기로 했습니다"], score: null, fallback: false }] },
      { section: "skills", label: "직무 역량", skipped: false, rounds: [{ round: 0, status: "failed", summary: [], score: null, fallback: true }] },
      { section: "projects", label: "대표 프로젝트", skipped: false, rounds: [{ round: 0, status: "done", summary: [], score: null, fallback: true }] },
      { section: "motivation_draft", label: "지원 동기 초안", skipped: true, rounds: [] },
    ],
    orchestrator: [{ round: 0, summary: "누락 키워드를 채우게 했다", feedback: [{ section: "experience", label: "경력", instructions: ["'상품 캐시 개편'의 Redis 근거를 첫 줄로"] }] }],
  });

  it("총괄 타임라인 + 구역 카드(완료·유지·실패→이전 결과·대체 작성·건너뜀) + 총괄 피드백(E… 미노출)", () => {
    const html = renderToStaticMarkup(<AgentProgress initialJob={job(v2())} />);
    expect(html).toContain("저장된 JD 분석을 사용했습니다");
    expect(html).toContain("구역 에이전트 작성");
    expect(html).toContain("지시받은 구역 다시 쓰기 1회차");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("R1·R2 담당 · 회사 1개");
    expect(html).toContain("1회차 작성 중");
    expect(html).toContain("1회차 유지");
    expect(html).toContain("초안 실패 → 이전 결과 사용");
    expect(html).toContain("초안 완료(대체 작성)");
    expect(html).toContain("이 이력서에는 쓰지 않습니다");
    expect(html).toContain("총괄 피드백 1회차");
    expect(html).toContain("Redis 근거를 첫 줄로");
    expect(html).not.toMatch(/\bE\d{1,3}\b/);
  });

  it("v1 작업은 예전 화면 그대로(구역 카드 없음)", () => {
    const html = renderToStaticMarkup(<AgentProgress initialJob={job({ pipelineVersion: 1 })} />);
    expect(html).not.toContain("구역 에이전트");
    expect(html).toContain("초안 심사");
  });
});

describe("AgentReport", () => {
  const report = {
    version: 1 as const,
    jd: { source: "jd" as const, roleTitle: "백엔드", company: "토스", mustTotal: 1, niceTotal: 0 },
    rounds: [{ round: 0, passCount: 2, passTotal: 3, matchScore: 80, panelScore: 72, atsPass: true, verdicts: [], changes: [], summary: "첫 초안" }],
    chosenRound: 0,
    finalPanel: null,
    stopReason: "plateau" as const,
    generatedAt: "2026-11-07T00:00:00.000Z",
    requirements: [{ requirementId: "R1", text: "Kafka 운영", must: true, status: "met" as const, resumeLine: "Kafka로 주문 이벤트를 나눴다", evidence: [{ name: "주문 시스템", label: "Project" as const, path: "나 → 주문 시스템(프로젝트)" }], inferred: false }],
    gaps: [{ requirementId: "R2", question: "AWS 비용 최적화 경험이 있나요?", chatPrompt: "'AWS 비용 최적화' 관련 경험을 정리하고 싶어요." }],
    factCheck: { numbersFlagged: 2, dropped: 1, corrected: 0 },
    excluded: [],
    notes: [],
    graphChanged: false,
  };

  it("요건 표·공백 질문의 그래프 채팅 링크(/app/graph?ask=…#graph-chat)·다시 실행 안내", () => {
    const html = renderToStaticMarkup(
      <AgentReport report={report} currentText="Kafka로 주문 이벤트를 나눴다" defaultOpen rerun={{ kind: "company", company: "토스", roleTitle: "백엔드", jdText: "", postingId: null, templateId: "developer" }} />,
    );
    expect(html).toContain("Kafka 운영");
    expect(html).toContain("충족");
    expect(html).toMatch(/href="\/app\/graph\?ask=[^"]*AWS[^"]*#graph-chat"/);
    expect(html).toContain("새 이력서가 하나 더 생깁니다");
    expect(html).toContain("작성 시점");
    expect(html).toContain("수치 확인 필요 2건");
  });

  it("편집으로 사라진 줄은 흐리게, 머리말은 멈춘 이유를 반영", () => {
    expect(lineStillPresent("Kafka로 주문 이벤트를 나눴다", "- Kafka로  주문 이벤트를 나눴다")).toBe(true);
    expect(lineStillPresent("Kafka로 주문 이벤트를 나눴다", "다른 문장")).toBe(false);
    const panel = { passCount: 5, total: 7 as const, verdicts: [] };
    expect(reportHeadline({ ...report, finalPanel: panel })).toContain("채울 정보 1개");
    expect(reportHeadline({ ...report, stopReason: "passed", finalPanel: panel })).toContain("7명 중 5명");
    // 최종 심사 결과가 없으면(final_panel 실패·건너뜀) '목표 달성'이 아니라 심사 미완료 안내.
    expect(reportHeadline({ ...report, stopReason: "passed", finalPanel: null })).toContain("심사를 끝내지 못했습니다");
    // 채울 정보가 0개면 '0개를 답하면'이라고 쓰지 않는다.
    expect(reportHeadline({ ...report, gaps: [], finalPanel: panel })).not.toContain("0개");
  });

  it("v2: 구역별 작성 표·총괄 피드백 기록·지원 동기 안내, 바뀐 점에 구역 라벨", () => {
    const v2 = {
      ...report,
      version: 2 as const,
      rounds: [...report.rounds, { round: 1, passCount: 2, passTotal: 3, matchScore: 85, panelScore: 75, atsPass: true, verdicts: [], changes: [{ round: 1, op: "insert" as const, path: "experience[0].bullets[0]", before: null, after: "Redis 캐시 계층을 설계했다", issueIds: [], reviewers: ["ats"] }], summary: "" }],
      sections: [
        { section: "experience" as const, label: "경력", requirementIds: ["R1", "R2"], finalRound: 1, rewrites: 1, score: 70, chars: 420, budget: 700, fallback: false, notes: [] },
        { section: "skills" as const, label: "직무 역량", requirementIds: [], finalRound: 0, rewrites: 0, score: null, chars: 90, budget: 180, fallback: true, notes: [] },
        { section: "motivation_draft" as const, label: "지원 동기 초안", requirementIds: [], finalRound: 0, rewrites: 0, score: null, chars: 320, budget: 800, fallback: false, notes: [] },
      ],
      orchestration: [{ round: 0, summary: "누락 키워드", feedback: [{ section: "경력", instructions: ["Redis 근거를 첫 줄로"] }] }],
      motivation: { drafted: true, placeholders: 2, suggestionSaved: true },
      jdReused: { kind: "diagnosis" as const, id: "d1", at: null },
    };
    const html = renderToStaticMarkup(<AgentReport report={v2} currentText="" defaultOpen rerun={null} />);
    expect(html).toContain("구역별 작성");
    expect(html).toContain("R1, R2");
    expect(html).toContain("420/700자");
    expect(html).toContain("1회차");
    expect(html).toContain("(대체)");
    expect(html).toContain("총괄 피드백 기록");
    expect(html).toContain("[ADD] 2곳을 채우고");
    expect(html).toContain("지원 동기 열기");
    expect(html).toContain("저장된 진단의 JD 분석");
    expect(html).toContain("경력 · ");
    expect(changeSectionLabel("education[0]")).toBe("수상·기타·학력·자격");
    expect(changeSectionLabel("summary")).toBe("요약·상단");
    expect(motivationNotice({ drafted: false, placeholders: 0, suggestionSaved: false })).toBeNull();
    // v1 리포트는 새 표 없이 그대로.
    expect(renderToStaticMarkup(<AgentReport report={report} currentText="" defaultOpen rerun={null} />)).not.toContain("구역별 작성");
  });
});
