import { STAGE_LABELS } from "@/lib/domain/reviewers";
import type { DiagnosisStatus, StageKey, StageStatus } from "@/lib/domain/schemas";

export interface StageState {
  stage: StageKey;
  status: StageStatus;
  error: string | null;
}

/** 진행 화면의 단계 묶음. 순서는 파이프라인 실행 순서(STAGE_DEPENDENCIES)와 같다. */
export const STAGE_GROUPS: { id: string; title: string; hint?: string; stages: StageKey[] }[] = [
  { id: "jd", title: "JD 분석", hint: "공고에서 요건·키워드를 뽑습니다", stages: ["jd"] },
  {
    id: "panel",
    title: "심사위원 7명 + 적합도",
    hint: "서로의 결과를 보지 않고 동시에 심사합니다",
    stages: ["ats", "gatekeeper", "manager", "rival", "ceo", "recruiter", "teammate", "fit"],
  },
  { id: "synthesis", title: "종합", hint: "지적을 합치고 심각도순으로 정리합니다", stages: ["synthesis"] },
  {
    id: "improve",
    title: "재작성 · 개선 방향성",
    hint: "같은 사실로 다시 쓰고, 방향을 세웁니다",
    stages: ["rewrite", "plan"],
  },
  { id: "rescreen", title: "재심사", hint: "재작성본을 자동 필터에 다시 넣습니다", stages: ["rescreen"] },
];

export function stageLabel(stage: StageKey): string {
  return STAGE_LABELS[stage];
}

/** 묶음 상태: 하나라도 실패면 failed, 전부 done이면 done, 일부라도 시작됐으면 running. */
export function groupStatus(stages: StageKey[], states: StageState[]): StageStatus {
  const byKey = new Map(states.map((s) => [s.stage, s.status]));
  const list = stages.map((k) => byKey.get(k) ?? "pending");
  if (list.includes("failed")) return "failed";
  if (list.every((s) => s === "done")) return "done";
  if (list.some((s) => s === "running" || s === "done")) return "running";
  return "pending";
}

export function progressCounts(states: StageState[]): { done: number; total: number } {
  return { done: states.filter((s) => s.status === "done").length, total: states.length };
}

export function isActiveStatus(status: DiagnosisStatus): boolean {
  return status === "queued" || status === "running";
}

export const DIAGNOSIS_STATUS_VIEW: Record<
  DiagnosisStatus,
  { label: string; tone: "neutral" | "info" | "positive" | "negative" }
> = {
  queued: { label: "대기 중", tone: "neutral" },
  running: { label: "진행 중", tone: "info" },
  done: { label: "완료", tone: "positive" },
  failed: { label: "실패", tone: "negative" },
};

/** 서버·클라이언트 결과가 같도록 시간대를 고정해 포맷한다(하이드레이션 불일치 방지). */
export function formatDateTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}분 ${String(s).padStart(2, "0")}초` : `${s}초`;
}
