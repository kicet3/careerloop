import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ResumeAgentJobView } from "@/lib/resume-agent/job-types";
import { AGENT_POLL_MS, AGENT_POLL_SLOW_MS, agentPollMs, AgentProgress, agentStatusMessage } from "./AgentProgress";
import { AgentReport, lineStillPresent, reportHeadline } from "./AgentReport";

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
    expect(html).toContain("하루 한도(5회) 중 1회");
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
});
