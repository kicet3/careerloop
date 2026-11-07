/**
 * AI 이력서 초안 작업의 화면용 타입·상수(클라이언트·서버 공용, 순수). 저장·실행은 ./draft-jobs.ts.
 */

export const RESUME_DRAFT_JOB_STATUSES = ["running", "completed", "failed"] as const;
export type ResumeDraftJobStatus = (typeof RESUME_DRAFT_JOB_STATUSES)[number];

/** 진행 단계: 자료 모으기 → AI 초안 쓰기 → 저장. */
export const RESUME_DRAFT_JOB_STAGES = ["material", "writing", "saving"] as const;
export type ResumeDraftJobStage = (typeof RESUME_DRAFT_JOB_STAGES)[number];

/** 진행 화면에 보이는 단계(마지막 '완료' 포함). */
export const RESUME_DRAFT_STEP_LABELS = [
  { key: "material", label: "자료 모으는 중", done: "자료 모음" },
  { key: "writing", label: "AI가 초안 쓰는 중", done: "초안 씀" },
  { key: "saving", label: "저장 중", done: "저장함" },
  { key: "done", label: "완료", done: "완료" },
] as const;

export interface ResumeDraftJobView {
  id: string;
  status: ResumeDraftJobStatus;
  stage: ResumeDraftJobStage;
  /** "회사 · 직무" 또는 "공용 이력서". */
  label: string;
  error: string | null;
  /** 완료하면 만든 이력서 id. */
  resumeId: string | null;
  notes: string[];
  missingInfo: string[];
  /** 다시 시도할 수 있는가(실패했고 입력이 남아 있다). */
  canRetry: boolean;
  attempts: number;
  /** 현재 실행 시작 시각(경과 시간 표시용). */
  startedAt: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** 'agent'면 그래프 이력서 에이전트 작업(진행 화면이 다르다 — href). 없으면 단일 초안. */
  mode?: "single" | "agent";
  /** 진행 화면 경로(없으면 /app/resumes/drafts/[id]). */
  href?: string;
  /** 단계 이름(에이전트 작업). 없으면 stage로 정한다. */
  stageLabel?: string;
}

/** 진행 화면 경로. */
export function draftJobHref(job: Pick<ResumeDraftJobView, "id" | "href">): string {
  return job.href ?? `/app/resumes/drafts/${job.id}`;
}

/** POST /api/resumes(AI 초안) 202 응답. */
export interface StartResumeDraftResponse {
  draftJob: ResumeDraftJobView;
  /** 에이전트를 요청했지만 쓸 수 없어 빠른 초안으로 만들었다. */
  modeFallback?: "agent_unavailable";
}

/** 진행 화면 단계 표시: 각 단계가 끝났는지·진행 중인지·실패했는지. */
export function draftStepStates(job: Pick<ResumeDraftJobView, "status" | "stage">): ("done" | "active" | "failed" | "todo")[] {
  const at = job.status === "completed" ? RESUME_DRAFT_STEP_LABELS.length - 1 : RESUME_DRAFT_JOB_STAGES.indexOf(job.stage);
  return RESUME_DRAFT_STEP_LABELS.map((_, i) => {
    if (job.status === "completed") return "done";
    if (i < at) return "done";
    if (i === at) return job.status === "failed" ? "failed" : "active";
    return "todo";
  });
}

/** 경과 시간 "1분 05초" / "42초". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}분 ${String(s % 60).padStart(2, "0")}초` : `${s}초`;
}
