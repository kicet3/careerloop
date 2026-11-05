/**
 * 지원 성과 집계(순수 함수, 클라이언트·서버 공용). 입력은 지원 목록·단계 이벤트·보관 공고, 출력은 domain/applications.ts의
 * 인사이트 형태. 모두 '실제로 일어난 결과'만 센다 — 진단 점수는 나란히 보여 줄 뿐 결과를 예측하지 않는다.
 *
 * CareerLoop(src/lib/analytics.ts)에서 가져옴. 고친 점:
 * - R-12 응답률 정의 통일: 분모 = 지원 완료 이후 단계에 '한 번이라도' 도달, 분자 = 과제·면접·최종 합격에 '한 번이라도' 도달.
 *   지금 단계가 아니라 이벤트 기록으로 센다(면접 뒤 불합격도 응답으로 센다). 전체·이력서별이 같은 정의를 쓴다.
 * - R-13 마감 계산: 행동 제안도 공고 배지와 같은 deadlineInfo(KST·마감 시각 반영)를 쓴다.
 * - 날짜는 모두 KST 문자열(src/lib/time/kst.ts) — 로컬 시간대를 쓰지 않는다.
 */
import {
  APPLICATION_STAGES,
  CLOSED_STAGES,
  RESPONSE_STAGES,
  SUBMITTED_STAGES,
  type ApplicationStage,
  type CompanyRollupRow,
  type JobApplication,
  type ResponseRate,
  type ResumePerformanceRow,
  type StageFunnelRow,
  type Suggestion,
} from "@/lib/domain/applications";
import type { JobPosting } from "@/lib/domain/postings";
import { deadlineInfo } from "@/lib/postings/deadline";
import { daysBetween, kstDate, kstToday } from "@/lib/time/kst";

/** 집계에 필요한 지원 필드. */
export type InsightApplication = Pick<
  JobApplication,
  "id" | "postingId" | "company" | "roleTitle" | "stage" | "appliedAt" | "nextStep" | "nextDate" | "resumeId" | "resumeVersionId" | "resumeLabel" | "createdAt" | "updatedAt"
>;
/** 집계에 필요한 이벤트 필드. */
export interface InsightEvent {
  applicationId: string;
  toStage: ApplicationStage;
  at?: number;
}
/** 제안에 필요한 공고 필드. */
export type InsightPosting = Pick<JobPosting, "id" | "company" | "roleTitle" | "status" | "deadline" | "deadlineTime" | "deadlineKind">;

/** 지원별로 한 번이라도 도달한 단계(이벤트 + 지금 단계 — 이벤트가 빠진 예전 행도 지금 단계만큼은 센다). */
export function reachedStages(apps: readonly InsightApplication[], events: readonly InsightEvent[]): Map<string, Set<ApplicationStage>> {
  const map = new Map<string, Set<ApplicationStage>>();
  for (const a of apps) map.set(a.id, new Set([a.stage]));
  for (const e of events) map.get(e.applicationId)?.add(e.toStage);
  return map;
}

const anyIn = (reached: Set<ApplicationStage> | undefined, stages: readonly ApplicationStage[]) =>
  !!reached && stages.some((s) => reached.has(s));

function rateOf(submitted: number, responded: number): ResponseRate {
  return { submitted, responded, rate: submitted === 0 ? null : responded / submitted };
}

/** 응답률(정의는 파일 머리 주석). rate는 0~1, 분모가 0이면 null. */
export function responseRate(apps: readonly InsightApplication[], events: readonly InsightEvent[]): ResponseRate {
  const reached = reachedStages(apps, events);
  let submitted = 0;
  let responded = 0;
  for (const a of apps) {
    const r = reached.get(a.id);
    if (!anyIn(r, SUBMITTED_STAGES)) continue;
    submitted += 1;
    if (anyIn(r, RESPONSE_STAGES)) responded += 1;
  }
  return rateOf(submitted, responded);
}

/**
 * 단계별 도달·현재 수. reached는 이벤트 기준이되, '지원 완료'는 지원서를 낸 모든 지원(응답률 분모와 같은 수)으로 센다 —
 * 처음부터 면접 단계로 기록한 지원도 지원서는 낸 것이므로.
 */
export function stageFunnel(apps: readonly InsightApplication[], events: readonly InsightEvent[]): StageFunnelRow[] {
  const reached = reachedStages(apps, events);
  return APPLICATION_STAGES.map((stage) => {
    let reachedCount = 0;
    let current = 0;
    for (const a of apps) {
      const r = reached.get(a.id);
      if (stage === "applied" ? anyIn(r, SUBMITTED_STAGES) : r?.has(stage)) reachedCount += 1;
      if (a.stage === stage) current += 1;
    }
    return { stage, reached: reachedCount, current };
  });
}

/** 이력서 버전별 성과. 지원서를 낸 지원만 센다. 이력서를 기록하지 않은 지원은 한 줄로 묶는다. 많이 쓴 버전부터. */
export function resumePerformance(apps: readonly InsightApplication[], events: readonly InsightEvent[]): ResumePerformanceRow[] {
  const reached = reachedStages(apps, events);
  const rows = new Map<string, { resumeId: string | null; resumeVersionId: string | null; label: string; submitted: number; responded: number }>();
  for (const a of apps) {
    const r = reached.get(a.id);
    if (!anyIn(r, SUBMITTED_STAGES)) continue;
    // 버전이 있으면 버전 단위, 이력서만 있으면 이력서 단위, 둘 다 없으면 '기록 없음'.
    const key = a.resumeVersionId ? `v:${a.resumeVersionId}` : a.resumeId ? `r:${a.resumeId}` : "none";
    let row = rows.get(key);
    if (!row) {
      row = {
        resumeId: a.resumeId,
        resumeVersionId: a.resumeVersionId,
        label: key === "none" ? "이력서 기록 없음" : a.resumeLabel || "이름 없는 이력서",
        submitted: 0,
        responded: 0,
      };
      rows.set(key, row);
    }
    row.submitted += 1;
    if (anyIn(r, RESPONSE_STAGES)) row.responded += 1;
  }
  return [...rows.values()]
    .map((r) => ({ ...r, ...rateOf(r.submitted, r.responded) }))
    .sort((a, b) => b.submitted - a.submitted || a.label.localeCompare(b.label, "ko"));
}

/** 회사 단위 비교에서 '가장 앞선 단계'의 순위. 종료(불합격·취소)는 진행 단계보다 뒤로 둔다. */
const STAGE_RANK: Record<ApplicationStage, number> = {
  withdrawn: 0,
  rejected: 1,
  interested: 2,
  applied: 3,
  assignment: 4,
  interview: 5,
  offer: 6,
};

const companyKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * 회사별 묶음. matchScore는 그 회사 지원에 연결된 완료 진단 적합도(fit.matchScore) 중 가장 높은 값 — 결과와 나란히 보여 주는
 * 참고 값이다. scores: 지원 id → 점수. 지원이 많은 회사부터.
 */
export function companyRollup(apps: readonly InsightApplication[], scores: ReadonlyMap<string, number>): CompanyRollupRow[] {
  const groups = new Map<string, { company: string; applications: number; bestStage: ApplicationStage; matchScore: number | null }>();
  for (const a of apps) {
    const key = companyKey(a.company);
    if (!key) continue;
    const score = scores.get(a.id);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { company: a.company.trim(), applications: 1, bestStage: a.stage, matchScore: score ?? null });
      continue;
    }
    g.applications += 1;
    if (STAGE_RANK[a.stage] > STAGE_RANK[g.bestStage]) g.bestStage = a.stage;
    if (score !== undefined && (g.matchScore === null || score > g.matchScore)) g.matchScore = score;
  }
  return [...groups.values()].sort(
    (a, b) => b.applications - a.applications || STAGE_RANK[b.bestStage] - STAGE_RANK[a.bestStage] || a.company.localeCompare(b.company, "ko"),
  );
}

// ---------------------------------------------------------------------------
// 행동 제안
// ---------------------------------------------------------------------------

/** 지원 완료 뒤 이 일수가 지나도 단계가 그대로면 팔로업을 제안한다. */
export const FOLLOW_UP_DAYS = 10;
/** 다음 일정이 이 일수 안이면 알린다(지난 일정 포함). */
const NEXT_STEP_WINDOW_DAYS = 2;
/** 개별로 보여 줄 최대 건수(나머지는 '외 n건'). */
const MAX_ITEMS_PER_KIND = 3;
/** 응답률 제안: 이만큼 낸 뒤 이 비율 미만이면. */
const LOW_RESPONSE_MIN_SUBMITTED = 5;
const LOW_RESPONSE_RATE = 0.2;

const names = (list: { company: string }[], n = 2) => {
  const head = list
    .slice(0, n)
    .map((x) => x.company)
    .join(", ");
  return list.length > n ? `${head} 외 ${list.length - n}곳` : head;
};

/**
 * 지금 바로 할 일 제안(한국어 한 문장씩). 급한 것부터: 마감 임박 → 다음 일정 → 팔로업 → 마감 지난 공고 정리 → 지원 예정 → 이력서 기록 → 응답률.
 * now는 시각(ms) — 마감은 deadlineInfo(KST·마감 시각), 지원일·다음 일정은 KST 날짜로 비교한다. 할 일이 없으면 빈 배열.
 */
export function buildSuggestions(input: {
  applications: readonly InsightApplication[];
  postings: readonly InsightPosting[];
  events?: readonly InsightEvent[];
  now?: number | Date;
}): Suggestion[] {
  const now = input.now ?? Date.now();
  const today = kstToday(now);
  const apps = input.applications;
  const events = input.events ?? [];
  const out: Suggestion[] = [];
  const appliedPostingIds = new Set(apps.map((a) => a.postingId).filter((x): x is string => !!x));

  // 1) 마감 임박(deadlineInfo의 urgent·soon = 7일 안, 아직 안 지남): 공고 배지와 같은 판단. 이미 지원했거나 마감·보류로 정리한 공고는 뺀다.
  const openPostings = input.postings.filter(
    (p) => p.status !== "closed" && p.status !== "applied" && p.status !== "on_hold" && !appliedPostingIds.has(p.id),
  );
  const withInfo = openPostings.map((p) => ({ p, info: deadlineInfo(p, now) }));
  const closing = withInfo
    .filter(({ info }) => info.level === "urgent" || info.level === "soon")
    .sort((a, b) => (a.info.days ?? 0) - (b.info.days ?? 0));
  for (const { p, info } of closing.slice(0, MAX_ITEMS_PER_KIND)) {
    out.push({
      kind: "deadline",
      message: `${p.company} ${p.roleTitle} 공고가 곧 마감됩니다(${info.label}). 지원할지 오늘 정해 보세요.`,
      href: `/app/postings/${p.id}`,
      postingId: p.id,
      applicationId: null,
    });
  }
  if (closing.length > MAX_ITEMS_PER_KIND) {
    out.push({
      kind: "deadline",
      message: `그 밖에도 7일 안에 마감되는 공고가 ${closing.length - MAX_ITEMS_PER_KIND}건 더 있습니다.`,
      href: "/app/postings",
      postingId: null,
      applicationId: null,
    });
  }

  // 2) 다음 일정(지났거나 2일 안). 끝난 지원은 뺀다.
  const upcoming = apps
    .filter((a) => !CLOSED_STAGES.includes(a.stage) && a.nextDate)
    .map((a) => ({ a, diff: daysBetween(today, a.nextDate!) }))
    .filter((x): x is { a: InsightApplication; diff: number } => x.diff !== null && x.diff <= NEXT_STEP_WINDOW_DAYS)
    .sort((x, y) => x.diff - y.diff);
  for (const { a, diff } of upcoming.slice(0, MAX_ITEMS_PER_KIND)) {
    const when = diff < 0 ? `${-diff}일 지난` : diff === 0 ? "오늘" : diff === 1 ? "내일" : "모레";
    const step = a.nextStep || "다음 일정";
    out.push({
      kind: "next_step",
      message:
        diff < 0
          ? `${a.company}의 '${step}' 일정이 ${when} 상태입니다. 결과나 새 일정을 기록해 두세요.`
          : `${when} ${a.company}의 '${step}' 일정이 있습니다.`,
      href: `/app/applications?open=${a.id}`,
      postingId: a.postingId,
      applicationId: a.id,
    });
  }

  // 3) 팔로업: 지원 완료 단계 그대로 10일 이상. 기준일은 지원일, 없으면 지원 완료가 된 시각(이벤트), 그것도 없으면 만든 날.
  const appliedAtBy = new Map<string, number>();
  for (const e of events) {
    if (e.toStage === "applied" && e.at !== undefined) appliedAtBy.set(e.applicationId, Math.max(appliedAtBy.get(e.applicationId) ?? 0, e.at));
  }
  const stalled = apps.filter((a) => {
    if (a.stage !== "applied") return false;
    const since = a.appliedAt ?? kstDate(appliedAtBy.get(a.id) ?? a.createdAt);
    const diff = daysBetween(since, today);
    return diff !== null && diff >= FOLLOW_UP_DAYS;
  });
  if (stalled.length > 0) {
    out.push({
      kind: "follow_up",
      message: `${names(stalled)}에 지원한 지 ${FOLLOW_UP_DAYS}일이 넘도록 다음 단계 소식이 없습니다. 진행 상황을 문의해 볼 때입니다.`,
      href: stalled.length === 1 ? `/app/applications?open=${stalled[0]!.id}` : "/app/applications",
      postingId: stalled.length === 1 ? stalled[0]!.postingId : null,
      applicationId: stalled.length === 1 ? stalled[0]!.id : null,
    });
  }

  // 4) 마감이 지난 공고 정리.
  const overdue = withInfo.filter(({ info }) => info.level === "past");
  if (overdue.length > 0) {
    out.push({
      kind: "deadline",
      message: `마감이 지난 공고 ${overdue.length}건이 보관함에 남아 있습니다. '마감'으로 정리하면 지원할 공고만 남습니다.`,
      href: "/app/postings",
      postingId: overdue.length === 1 ? overdue[0]!.p.id : null,
      applicationId: null,
    });
  }

  // 5) 지원 예정인데 지원 기록이 없는 공고.
  const planned = input.postings.filter((p) => p.status === "planned" && !appliedPostingIds.has(p.id));
  if (planned.length > 0) {
    out.push({
      kind: "pipeline",
      message: `지원 예정으로 표시한 공고 ${planned.length}건에 아직 지원 기록이 없습니다. 지원했다면 기록을 남겨 두세요.`,
      href: planned.length === 1 ? `/app/postings/${planned[0]!.id}` : "/app/postings",
      postingId: planned.length === 1 ? planned[0]!.id : null,
      applicationId: null,
    });
  }

  // 6) 낸 이력서를 기록하지 않은 지원(버전별 성과를 비교할 수 없다).
  const reached = reachedStages(apps, events);
  const noResume = apps.filter((a) => !a.resumeId && !a.resumeVersionId && anyIn(reached.get(a.id), SUBMITTED_STAGES));
  if (noResume.length > 0) {
    out.push({
      kind: "resume",
      message: `제출한 이력서를 기록하지 않은 지원이 ${noResume.length}건 있습니다. 어떤 버전을 냈는지 남겨야 버전별 결과를 비교할 수 있습니다.`,
      href: noResume.length === 1 ? `/app/applications?open=${noResume[0]!.id}` : "/app/applications",
      postingId: null,
      applicationId: noResume.length === 1 ? noResume[0]!.id : null,
    });
  }

  // 7) 응답률이 낮을 때: 진단으로 서류부터 점검.
  const rate = responseRate(apps, events);
  if (rate.submitted >= LOW_RESPONSE_MIN_SUBMITTED && rate.rate !== null && rate.rate < LOW_RESPONSE_RATE) {
    out.push({
      kind: "pipeline",
      message: `지원 ${rate.submitted}건 중 다음 단계 연락은 ${rate.responded}건(${Math.round(rate.rate * 100)}%)입니다. 지원할 공고로 이력서 진단을 받아 서류부터 점검해 보세요.`,
      href: "/app/new",
      postingId: null,
      applicationId: null,
    });
  }

  return out;
}

