/**
 * 그래프 이력서 에이전트의 화면용 타입·단계 라벨·상수(클라이언트·서버 공용, 순수). 저장·실행은 ./jobs.ts.
 * 뷰에는 근거 텍스트·JD 원문·노드 id를 싣지 않는다(toAgentJobView가 허용 필드만 담는다).
 */
import type { ReviewerId } from "@/lib/domain/schemas";
import type { StopReason } from "./schemas";

export const AGENT_STEP_KINDS = ["jd", "retrieve", "plan", "write_body", "write_top", "review", "revise", "final_panel", "finalize"] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export const AGENT_JOB_STATUSES = ["running", "waiting", "completed", "failed", "canceled"] as const;
export type ResumeAgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

export const AGENT_STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type AgentStepStatus = (typeof AGENT_STEP_STATUSES)[number];

export const AGENT_STEP_LABELS: Record<AgentStepKind, { label: string; done: string }> = {
  jd: { label: "JD 요건 분석 중", done: "JD 분석" },
  retrieve: { label: "경험 그래프에서 근거 찾는 중", done: "경험 검색" },
  plan: { label: "요건별 근거·전략 짜는 중", done: "전략" },
  write_body: { label: "경력·프로젝트 쓰는 중", done: "본문 작성" },
  write_top: { label: "요약·핵심 성과 쓰고 사실 확인 중", done: "초안 완성·사실 검증" },
  review: { label: "심사위원 심사 중", done: "심사" },
  revise: { label: "지적 반영해 고치는 중", done: "수정" },
  final_panel: { label: "최종본 심사위원 7명 심사 중", done: "최종 심사" },
  finalize: { label: "저장 중", done: "저장" },
};

/** 리포트 '바뀐 점'의 수정 종류 라벨(schemas.ts PATCH_OPS). */
export const PATCH_OP_LABELS: Record<string, string> = {
  replace: "문장 고침",
  insert: "줄 추가",
  remove: "줄 삭제",
  reorder: "순서 변경",
  addProject: "프로젝트 추가",
  setSkills: "기술 정리",
};

/** 심사위원 7명 밖의 지적 출처(ReviewIssue.reviewer의 fit·verify). */
export const EXTRA_REVIEWER_LABELS: Record<string, string> = { fit: "적합도 심사", verify: "사실 검증" };

/** 종료 기준(화면 목표선). stop.ts STOP_RULES와 같아야 한다. */
export const AGENT_TARGETS = { minCorePass: 2, coreTotal: 3, minMatchScore: 75, minMatchScoreInferred: 70 } as const;

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  passed: "목표 달성",
  plateau: "더 나아지지 않아 멈춤",
  max_rounds: "최대 수정 횟수 도달",
  only_user_gaps: "남은 지적은 정보가 더 필요함",
  budget: "비용 상한에 걸려 멈춤",
  review_failed: "심사를 끝내지 못함",
};

/** 실패 사유 코드(화면 분기용). */
export const AGENT_ERROR_CODES = ["insufficient_graph", "schema_version", "idle", "step_failed", "input_missing", "continuations"] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentStepView {
  key: string;
  kind: AgentStepKind;
  round: number;
  status: AgentStepStatus;
  /** 화면용 한 줄 요약들(근거 커버리지, 포지셔닝, 수치 확인 n건 …). */
  summary: string[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RoundVerdictView {
  reviewer: ReviewerId;
  verdict: string;
  positive: boolean;
  oneLiner: string;
}

export interface RoundScoreView {
  round: number;
  passCount: number;
  passTotal: number;
  matchScore: number;
  panelScore: number;
  atsPass: boolean;
  incomplete: boolean;
  verdicts: RoundVerdictView[];
}

export interface FinalPanelView {
  passCount: number;
  total: 7;
  verdicts: { reviewer: ReviewerId; verdict: string | null; positive: boolean; oneLiner: string }[];
}

export interface ResumeAgentJobView {
  id: string;
  mode: "agent";
  status: ResumeAgentJobStatus;
  label: string;
  currentStep: string;
  steps: AgentStepView[];
  rounds: RoundScoreView[];
  finalPanel: FinalPanelView | null;
  coverage: { mustFound: number; mustTotal: number; niceFound: number; niceTotal: number } | null;
  stopReason: StopReason | null;
  error: string | null;
  errorCode: AgentErrorCode | null;
  failedStep: string | null;
  canRetry: boolean;
  /** 입력이 남아 있어 '빠른 초안으로 만들기'를 할 수 있다. */
  canFallback: boolean;
  /** 화면이 POST …/advance를 보내야 한다(대기 중인데 이어 줄 호출이 없음). */
  needsKick: boolean;
  /** 연쇄(서명된 자기 호출)가 꺼진 배포: 화면을 열어 두면 더 빨리 끝난다. */
  chainEnabled: boolean;
  resumeId: string | null;
  /** 지금까지 가장 좋은 검증 초안(근거 텍스트·노드 id 없음). */
  previewText: string | null;
  attempts: number;
  startedAt: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** POST /api/resumes(mode=agent) 202 응답. */
export interface StartResumeAgentResponse {
  agentJob: ResumeAgentJobView;
}

/** 단계 키 "r1.review" → { round: 1, kind: "review" }. "final_panel"·"finalize"는 round -1. */
export function parseStepKey(key: string): { round: number; kind: AgentStepKind } | null {
  if (key === "final_panel" || key === "finalize") return { round: -1, kind: key };
  const m = /^r(\d)\.([a-z_]+)$/.exec(key);
  if (!m || !(AGENT_STEP_KINDS as readonly string[]).includes(m[2]!)) return null;
  return { round: Number(m[1]), kind: m[2] as AgentStepKind };
}

export function stepKey(kind: AgentStepKind, round: number): string {
  return kind === "final_panel" || kind === "finalize" ? kind : `r${round}.${kind}`;
}

/** 진행 화면 제목. */
export function agentHeading(status: ResumeAgentJobStatus): string {
  switch (status) {
    case "completed":
      return "에이전트 이력서 완성";
    case "failed":
      return "에이전트가 이력서를 끝내지 못했습니다";
    case "canceled":
      return "에이전트 작업을 취소했습니다";
    default:
      return "AI 에이전트가 이력서를 쓰고 있습니다";
  }
}

/** 단계 이름(라운드 포함): "심사 1회차", "수정 2회차". */
export function stepTitle(kind: AgentStepKind, round: number): string {
  if (kind === "review") return round === 0 ? "초안 심사" : `심사 ${round + 1}회차`;
  if (kind === "revise") return `수정 ${round}회차`;
  return AGENT_STEP_LABELS[kind].done;
}
