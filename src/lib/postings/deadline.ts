/**
 * 공고 마감 계산(클라이언트·서버 공용, 순수). 모든 마감은 한국 시간(KST) 기준이다.
 * CareerLoop(src/lib/postings.ts 마감 절)에서 가져옴 — 원본의 daysUntil(date.ts)은 로컬 시간대를 써서
 * 서버(UTC)에서 남은 일수가 하루 어긋났다(R-13). 여기서는 src/lib/time/kst.ts만 쓴다.
 * 지원 추적(applications)의 buildSuggestions도 이 모듈을 쓴다.
 */
import type { DeadlineKind, JobPosting } from "@/lib/domain/postings";
import { DAY_MS, daysBetween, formatKstDate, isValidKstDate, isValidKstTime, kstDate, kstDateTimeToMs } from "@/lib/time/kst";

export const isValidDeadlineDate = isValidKstDate;
export const isValidDeadlineTime = isValidKstTime;

export type DeadlineLevel = "none" | "safe" | "soon" | "urgent" | "past";

export interface DeadlineInfo {
  level: DeadlineLevel;
  label: string;
  /** 오늘(KST)부터 마감일까지 남은 일수. 마감일이 없으면 null. */
  days: number | null;
}

type DeadlineFields = Pick<JobPosting, "deadline" | "deadlineTime">;

/** 마감 시각(ms). 시각이 없으면 그 날짜가 끝날 때(다음 날 0시 KST)까지 유효하다. 날짜가 틀리면 null. */
export function postingDeadlineAt(p: DeadlineFields): number | null {
  if (!isValidKstDate(p.deadline)) return null;
  if (isValidKstTime(p.deadlineTime)) return kstDateTimeToMs(p.deadline, p.deadlineTime);
  const start = kstDateTimeToMs(p.deadline);
  return start === null ? null : start + DAY_MS;
}

const NO_DEADLINE_LABEL: Record<DeadlineKind, string> = {
  rolling: "상시 채용",
  unspecified: "마감일 미공개",
  // 종류는 '마감일'인데 날짜가 비었거나 틀린 경우(손상된 행).
  date: "마감일 확인 필요",
};

/**
 * 마감 상태 배지. urgent: 3일 이내(시각이 있으면 24시간 이내는 남은 시간), soon: 7일 이내, past: 지남.
 * now는 시각(ms·Date) — 날짜 비교는 KST 달력으로 한다.
 */
export function deadlineInfo(
  p: Pick<JobPosting, "deadline" | "deadlineTime" | "deadlineKind">,
  now: number | Date = Date.now(),
): DeadlineInfo {
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!p.deadline) return { level: "none", label: NO_DEADLINE_LABEL[p.deadlineKind] ?? "마감일 미공개", days: null };
  if (!Number.isFinite(nowMs)) return { level: "none", label: "마감일 확인 필요", days: null };
  const at = postingDeadlineAt(p);
  const days = daysBetween(kstDate(nowMs), p.deadline);
  if (at === null || days === null) return { level: "none", label: "마감일 확인 필요", days: null };
  if (days < 0) return { level: "past", label: `마감 ${-days}일 지남`, days };
  const remaining = at - nowMs;
  if (remaining <= 0) return { level: "past", label: "마감됨", days };
  if (isValidKstTime(p.deadlineTime) && remaining <= DAY_MS) {
    const minutes = Math.ceil(remaining / 60_000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const label = hours ? `${hours}시간${rest ? ` ${rest}분` : ""} 남음` : `${minutes}분 남음`;
    return { level: "urgent", label, days };
  }
  if (days === 0) return { level: "urgent", label: "오늘 마감", days };
  if (days <= 3) return { level: "urgent", label: `D-${days}`, days };
  if (days <= 7) return { level: "soon", label: `D-${days}`, days };
  return { level: "safe", label: `D-${days}`, days };
}

/** 마감 7일 이내(아직 안 지남). */
export function isClosingSoon(p: Pick<JobPosting, "deadline" | "deadlineTime" | "deadlineKind">, now: number | Date = Date.now()): boolean {
  const level = deadlineInfo(p, now).level;
  return level === "urgent" || level === "soon";
}

/** "11월 20일 (금) 18:00 KST". 마감일이 없으면 마감 종류 이름(상시 채용·마감일 미공개). */
export function formatPostingDeadline(p: Pick<JobPosting, "deadline" | "deadlineTime"> & { deadlineKind?: DeadlineKind }): string {
  if (!isValidKstDate(p.deadline)) return p.deadline ? "마감일 확인 필요" : NO_DEADLINE_LABEL[p.deadlineKind ?? "unspecified"];
  const time = isValidKstTime(p.deadlineTime) ? ` ${p.deadlineTime} KST` : "";
  return `${formatKstDate(p.deadline, { withWeekday: true })}${time}`;
}
