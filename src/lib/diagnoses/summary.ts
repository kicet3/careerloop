/**
 * 진단 목록·생성에 쓰는 순수 계산(DB 무관, 테스트 대상).
 */
import { isPositiveVerdict } from "@/lib/domain/reviewers";
import { REVIEWER_IDS, type ReviewerId, type StageKey, type StageStatus } from "@/lib/domain/schemas";

export const DEFAULT_DAILY_LIMIT = 5;
/** 실행 중인 runDiagnosis가 진단 행의 updatedAt을 갱신하는 주기(하트비트). LLM 호출이 길어도 이 주기로 갱신된다. */
export const HEARTBEAT_MS = 30 * 1000;
/**
 * 하트비트가 이만큼 끊기면 실행 프로세스가 죽은 것(함수 시간 초과·서버 재시작)으로 보고 failed로 바꾼다.
 * 하트비트 주기의 4배라 살아 있는 실행을 잘못 끊지 않는다.
 */
export const STALE_AFTER_MS = 2 * 60 * 1000;
/** 진단 하나당 재시도 횟수 상한(같은 단계가 계속 실패할 때 비용이 끝없이 늘지 않도록). */
export const MAX_RETRIES_PER_DIAGNOSIS = 3;
/**
 * 서버 실행 시간 예산(Vercel maxDuration - 30초)에 걸려 멈춘 진단의 error 값. 실패가 아니라 '이어서 할 수 있는 멈춤'이라
 * 진행 화면이 이 값을 보면 남은 단계를 자동으로 이어서 실행한다(POST /api/diagnoses/[id]/retry?continue=1).
 */
export const DEADLINE_STOP_ERROR = "서버 실행 시간 제한으로 잠시 멈췄습니다. 완료된 단계는 건너뛰고 이어서 진행합니다.";
/** 시간 제한 뒤 자동 이어하기 상한(진단당). 사용자 재시도 횟수(MAX_RETRIES_PER_DIAGNOSIS)와 따로 센다. */
export const MAX_DEADLINE_CONTINUATIONS = 4;

/** 시간 예산에 걸려 멈춘(이어서 실행할 수 있는) 진단인가. */
export function isDeadlineStop(d: { status: string; error: string | null }): boolean {
  return d.status === "failed" && d.error === DEADLINE_STOP_ERROR;
}
export const MAX_RESUME_CHARS = 40_000;
export const MAX_JD_CHARS = 30_000;

export function dailyDiagnosisLimit(env: string | undefined = process.env.DAILY_DIAGNOSIS_LIMIT): number {
  const n = Number(env);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

type StageLike = { stage: StageKey; status: StageStatus; output: unknown };

function field(output: unknown, key: string): unknown {
  return output && typeof output === "object" ? (output as Record<string, unknown>)[key] : undefined;
}

/** 7명이 모두 끝났을 때만 긍정 판정 수를 센다. */
export function positiveCountOf(stages: StageLike[]): number | null {
  let done = 0;
  let positive = 0;
  for (const s of stages) {
    if (s.status !== "done" || !(REVIEWER_IDS as readonly string[]).includes(s.stage)) continue;
    done++;
    const verdict = field(s.output, "verdict");
    if (typeof verdict === "string" && isPositiveVerdict(s.stage as ReviewerId, verdict)) positive++;
  }
  return done === REVIEWER_IDS.length ? positive : null;
}

export function matchScoreOf(stages: StageLike[]): number | null {
  const fit = stages.find((s) => s.stage === "fit" && s.status === "done");
  const score = fit ? field(fit.output, "matchScore") : undefined;
  return typeof score === "number" ? score : null;
}

/**
 * 목록에서 진단을 서로 구별할 부제: JD 분석의 회사·포지션명(직무명과 다를 때), 이력서 파일명.
 * 아무것도 없으면 JD 유무만 알려 준다. 제목(직무 · 날짜)을 되풀이하지 않는다.
 */
export function diagnosisSubtitle(opts: {
  targetRole: string;
  jdOutput: unknown;
  resumeFileName: string | null;
  hasJd: boolean;
}): string {
  const parts: string[] = [];
  const company = field(opts.jdOutput, "company");
  const roleTitle = field(opts.jdOutput, "roleTitle");
  const source = field(opts.jdOutput, "source");
  if (source === "jd" && typeof company === "string" && company.trim()) parts.push(company.trim());
  if (
    source === "jd" &&
    typeof roleTitle === "string" &&
    roleTitle.trim() &&
    roleTitle.trim().toLowerCase() !== opts.targetRole.trim().toLowerCase()
  ) {
    parts.push(roleTitle.trim());
  }
  if (opts.resumeFileName) parts.push(opts.resumeFileName);
  if (!opts.hasJd) parts.push("JD 없음(직무명으로 추정)");
  else if (parts.length === 0) parts.push("JD 기준 심사");
  return parts.join(" · ");
}

/** 진단 제목: "지원 직무 · YYYY-MM-DD"(한국 시간). 직무가 비면 파일명. */
export function diagnosisTitle(targetRole: string, fileName: string | null, at: Date = new Date()): string {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(at);
  const base = targetRole.trim() || fileName?.replace(/\.[^.]+$/, "") || "이력서 진단";
  return `${base.slice(0, 120)} · ${date}`;
}
