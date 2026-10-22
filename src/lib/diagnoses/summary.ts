/**
 * 진단 목록·생성에 쓰는 순수 계산(DB 무관, 테스트 대상).
 */
import { isPositiveVerdict } from "@/lib/domain/reviewers";
import { REVIEWER_IDS, type ReviewerId, type StageKey, type StageStatus } from "@/lib/domain/schemas";

export const DEFAULT_DAILY_LIMIT = 5;
export const STALE_AFTER_MS = 10 * 60 * 1000;
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

/** 진단 제목: "지원 직무 · YYYY-MM-DD"(한국 시간). 직무가 비면 파일명. */
export function diagnosisTitle(targetRole: string, fileName: string | null, at: Date = new Date()): string {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(at);
  const base = targetRole.trim() || fileName?.replace(/\.[^.]+$/, "") || "이력서 진단";
  return `${base.slice(0, 120)} · ${date}`;
}
