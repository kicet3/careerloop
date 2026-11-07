/**
 * 그래프 이력서 에이전트의 화면용 타입·단계 라벨·상수(클라이언트·서버 공용, 순수). 저장·실행은 ./jobs.ts.
 * 뷰에는 근거 텍스트·JD 원문·노드 id를 싣지 않는다(toAgentJobView가 허용 필드만 담는다).
 */
import type { ReviewerId } from "@/lib/domain/schemas";
import type { StopReason } from "./schemas";

export const AGENT_STEP_KINDS = [
  "jd",
  "retrieve",
  "plan",
  "write_body",
  "write_top",
  "review",
  "revise",
  "final_panel",
  "finalize",
  // 파이프라인 v2(구역별 에이전트 + 총괄, docs/RESUME-SECTION-AGENTS.md)
  "brief",
  "section",
  "compose",
  "critique",
] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

/** 파이프라인 v2의 구역 에이전트. 앞 5개는 이력서 본문 경로를 갖는 구역(WRITING_SECTIONS), 뒤 2개는 지원 동기 칸(심사 텍스트 밖). */
export const SECTION_IDS = ["experience", "projects", "highlights", "skills", "extras", "motivation_draft", "motivation_suggest"] as const;
export type SectionId = (typeof SECTION_IDS)[number];
export const WRITING_SECTIONS = ["experience", "projects", "highlights", "skills", "extras"] as const;
export type WritingSection = (typeof WRITING_SECTIONS)[number];
export const MOTIVATION_SECTIONS = ["motivation_suggest", "motivation_draft"] as const;

/** 구역 이름(화면·리포트). */
export const SECTION_LABELS: Record<SectionId, string> = {
  experience: "경력",
  projects: "대표 프로젝트",
  highlights: "핵심 성과",
  skills: "직무 역량",
  extras: "수상·기타·학력·자격",
  motivation_draft: "지원 동기 초안",
  motivation_suggest: "지원 동기 추천",
};

/** 라운드 0의 웨이브: 웨이브 2는 웨이브 1 결과(실제로 쓴 경력·프로젝트 줄, 지원 동기 재료)를 읽는다. */
export const SECTION_WAVES: readonly (readonly SectionId[])[] = [
  ["experience", "projects", "extras", "motivation_suggest"],
  ["highlights", "skills", "motivation_draft"],
];

export const isSectionId = (v: string): v is SectionId => (SECTION_IDS as readonly string[]).includes(v);
export const isWritingSection = (v: string): v is WritingSection => (WRITING_SECTIONS as readonly string[]).includes(v);

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
  brief: { label: "총괄 에이전트가 구역별 작전을 세우는 중", done: "총괄 작전(요건 배정·분량)" },
  section: { label: "구역 에이전트가 쓰는 중", done: "구역 작성" },
  compose: { label: "총괄 에이전트가 구역을 조립하고 요약·사실 확인 중", done: "조립·요약·사실 검증" },
  critique: { label: "총괄 에이전트가 구역별 피드백을 정리하는 중", done: "총괄 피드백" },
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
  /** kind 'section'이면 구역 id. */
  section?: SectionId;
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

/** v2 구역 카드의 라운드 칩. kept = 총괄이 이 라운드에 다시 쓰라고 하지 않아 이전 결과를 그대로 썼다. */
export interface SectionRoundView {
  round: number;
  status: AgentStepStatus | "kept";
  summary: string[];
  /** 총괄 critique의 구역 점수(0~100, 없으면 null). */
  score: number | null;
  /** 실패해 이전 라운드 결과·대체 작성기를 썼다. */
  fallback: boolean;
}

export interface SectionCardView {
  section: SectionId;
  label: string;
  rounds: SectionRoundView[];
  /** 공용 이력서·기능 꺼짐으로 돌리지 않는 구역. */
  skipped: boolean;
}

/** 총괄 피드백(라운드별). 지시문 안의 근거 ref(E…)는 근거 이름으로 바꿨다. */
export interface OrchestratorFeedbackView {
  round: number;
  summary: string;
  feedback: { section: SectionId | "compose"; label: string; instructions: string[] }[];
}

export interface ResumeAgentJobView {
  id: string;
  mode: "agent";
  /** 단계 계획 버전(없으면 1). */
  pipelineVersion?: 1 | 2;
  /** v2만: 구역 카드. */
  sections?: SectionCardView[];
  /** v2만: 총괄 피드백 기록. */
  orchestrator?: OrchestratorFeedbackView[];
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
  /** '다시 생성' 작업이면 true(결과는 targetResumeId 이력서의 새 버전·새 리포트). */
  regenerate?: boolean;
  targetResumeId?: string | null;
}

/** 완료된 작업이 연 이력서 경로(리포트 펼침, 다시 생성이면 새 버전 배너). 알림 링크와 같은 값이다. */
export function agentCompletedHref(job: Pick<ResumeAgentJobView, "resumeId" | "regenerate">): string | null {
  if (!job.resumeId) return null;
  return job.regenerate ? `/app/resumes/${job.resumeId}?report=1&regenerated=1` : `/app/resumes/${job.resumeId}?report=1`;
}

/** POST /api/resumes(mode=agent) 202 응답. */
export interface StartResumeAgentResponse {
  agentJob: ResumeAgentJobView;
}

/** 단계 키 "r1.review" → { round: 1, kind: "review" }, "r1.sec.experience" → { round: 1, kind: "section", section }. "final_panel"·"finalize"는 round -1. */
export function parseStepKey(key: string): { round: number; kind: AgentStepKind; section?: SectionId } | null {
  if (key === "final_panel" || key === "finalize") return { round: -1, kind: key };
  const sec = /^r(\d)\.sec\.([a-z_]+)$/.exec(key);
  if (sec) return isSectionId(sec[2]!) ? { round: Number(sec[1]), kind: "section", section: sec[2] } : null;
  const m = /^r(\d)\.([a-z_]+)$/.exec(key);
  if (!m || m[2] === "section" || !(AGENT_STEP_KINDS as readonly string[]).includes(m[2]!)) return null;
  return { round: Number(m[1]), kind: m[2] as AgentStepKind };
}

export function stepKey(kind: AgentStepKind, round: number, section?: SectionId): string {
  if (kind === "section") {
    if (!section) throw new Error("구역 단계 키에는 구역 id가 필요하다");
    return sectionStepKey(section, round);
  }
  return kind === "final_panel" || kind === "finalize" ? kind : `r${round}.${kind}`;
}

export function sectionStepKey(section: SectionId, round: number): string {
  return `r${round}.sec.${section}`;
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
export function stepTitle(kind: AgentStepKind, round: number, section?: SectionId): string {
  if (kind === "review") return round === 0 ? "초안 심사" : `심사 ${round + 1}회차`;
  if (kind === "revise") return `수정 ${round}회차`;
  if (kind === "compose") return round === 0 ? "조립·요약·사실 검증" : `구역 재작성 반영·조립 ${round}회차`;
  if (kind === "critique") return round === 0 ? "총괄 피드백" : `총괄 피드백 ${round + 1}회차`;
  if (kind === "section" && section) return round === 0 ? `${SECTION_LABELS[section]} 작성` : `${SECTION_LABELS[section]} 다시 쓰기 ${round}회차`;
  return AGENT_STEP_LABELS[kind].done;
}
