/** 관리자 '사용량' 화면의 표시용 이름·숫자 형식(서버·클라이언트 공용). */
import { STAGE_LABELS } from "./reviewers";
import type { StageKey } from "./schemas";

export const LLM_USAGE_TASK_LABELS: Record<string, string> = {
  diagnosis: "이력서 진단",
  "graph-chat": "경험 정리하기(채팅)",
  "graph-import": "경험 가져오기(문서)",
  "graph-repo-import": "경험 가져오기(GitHub)",
  "graph-qa": "경험 질문하기",
  "graph-qa-rerank": "경험 질문하기(관련도)",
  "reviewer-chat": "심사위원 채팅",
  "resume-draft": "이력서 초안",
  "portfolio-draft": "포트폴리오(경험 그래프)",
  "posting-extract": "채용 공고 정리",
  "posting-translate": "채용 공고 번역",
  "interview-questions": "면접 질문 생성",
  "interview-feedback": "면접 답변 피드백",
};

/** 'diagnosis:ats' 같은 작업 키 → 표시 이름. 모르는 키는 그대로. */
export function llmUsageTaskLabel(key: string): string {
  const [task, stage] = key.split(":", 2);
  const base = LLM_USAGE_TASK_LABELS[task] ?? task;
  if (!stage) return base;
  return `${base} · ${STAGE_LABELS[stage as StageKey] ?? stage}`;
}

/** 토큰 수(천 단위 쉼표). */
export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}

/** micro-USD → '$1.23'(1센트 미만은 소수 넷째 자리까지). */
export function formatMicroUsd(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0";
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const USAGE_PERIODS = ["today", "7d", "30d", "all"] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export const USAGE_PERIOD_LABELS: Record<UsagePeriod, string> = {
  today: "오늘",
  "7d": "7일",
  "30d": "30일",
  all: "전체",
};

export function isUsagePeriod(v: unknown): v is UsagePeriod {
  return typeof v === "string" && (USAGE_PERIODS as readonly string[]).includes(v);
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 기간의 시작 시각(포함). '오늘'·'N일'은 한국 시간 자정 기준(오늘 포함 N일). 전체면 null. */
export function periodStart(period: UsagePeriod, now: number = Date.now()): Date | null {
  if (period === "all") return null;
  const kstMidnight = Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
  return new Date(kstMidnight - (days - 1) * DAY_MS);
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 추정 비용(USD 백만분의 1). 단가를 아는 호출만 더한다. */
  costMicroUsd: number;
  /** 비용을 매기지 못한 호출 수(CLI 엔진·모르는 모델). */
  unpricedCalls: number;
}
