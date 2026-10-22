/**
 * 심사위원과 단계의 표시용 메타데이터(한국어 이름, 역할 설명, 판정 라벨).
 * 프롬프트의 페르소나 본문은 panel/prompts.ts에 있고, 여기서는 UI·보고서가 공유하는 정보만 둔다.
 */
import type { ReviewerId, StageKey } from "./schemas";

export type VerdictTone = "positive" | "neutral" | "negative";

export interface ReviewerMeta {
  id: ReviewerId;
  name: string;
  role: string;
  /** 판정 값 → 한국어 라벨과 톤 */
  verdicts: Record<string, { label: string; tone: VerdictTone }>;
}

const READER_VERDICTS = {
  HIRE: { label: "합격", tone: "positive" },
  MAYBE: { label: "보류", tone: "neutral" },
  PASS: { label: "거절", tone: "negative" },
} as const;

export const REVIEWERS: Record<ReviewerId, ReviewerMeta> = {
  ats: {
    id: "ats",
    name: "서류 자동 필터",
    role: "사람이 볼 자격이 있는지 정하는 ATS. 읽힘·직함·날짜·JD 키워드를 본다",
    verdicts: {
      PASS: { label: "통과", tone: "positive" },
      REJECT: { label: "탈락", tone: "negative" },
    },
  },
  gatekeeper: {
    id: "gatekeeper",
    name: "채용 담당자",
    role: "면접에 부를지 정한다. 처음 10초가 결정을 가른다",
    verdicts: {
      INTERVIEW: { label: "면접", tone: "positive" },
      NO: { label: "불합격", tone: "negative" },
    },
  },
  manager: {
    id: "manager",
    name: "팀장",
    role: "첫날부터 이 일을 해낼 수 있는지만 본다",
    verdicts: READER_VERDICTS,
  },
  rival: {
    id: "rival",
    name: "경쟁 지원자",
    role: "같은 자리에 지원했다. 내 이력서보다 어디가 약한지 찾는다",
    verdicts: READER_VERDICTS,
  },
  ceo: {
    id: "ceo",
    name: "대표",
    role: "무엇을 얼마나 바꿨는지, 임팩트만 본다",
    verdicts: READER_VERDICTS,
  },
  recruiter: {
    id: "recruiter",
    name: "리크루터",
    role: "오늘 이력서 100장, 한 장에 30초. 상단 3분의 1만 읽는다",
    verdicts: READER_VERDICTS,
  },
  teammate: {
    id: "teammate",
    name: "옆자리 동료",
    role: "같이 일하게 될 사람. 협업 방식과 본인 몫을 본다",
    verdicts: READER_VERDICTS,
  },
};

/** 진행 화면에 표시할 단계 이름. */
export const STAGE_LABELS: Record<StageKey, string> = {
  jd: "JD 분석",
  ats: "서류 자동 필터",
  gatekeeper: "채용 담당자",
  manager: "팀장",
  rival: "경쟁 지원자",
  ceo: "대표",
  recruiter: "리크루터",
  teammate: "옆자리 동료",
  fit: "JD 적합도 매칭",
  synthesis: "문제점 종합",
  rewrite: "이력서 재작성",
  plan: "개선 방향성",
  rescreen: "재작성본 자동 필터 재심사",
};

export const SITUATION_LABELS = {
  general: "일반 지원",
  career_change: "직무 전환",
  new_grad: "첫 취업(정규직 경력 없음)",
  rewrite_check: "이미 고친 이력서 재점검",
} as const;

/**
 * 판정이 "통과" 쪽인지. 요약 점수(x/7 통과) 계산에 쓴다.
 * 주의: ATS의 PASS는 통과지만 리더 5명의 PASS는 거절이라 반드시 심사위원 기준으로 판단한다.
 */
export function isPositiveVerdict(reviewer: ReviewerId, verdict: string): boolean {
  return REVIEWERS[reviewer].verdicts[verdict]?.tone === "positive";
}

export function verdictLabel(reviewer: ReviewerId, verdict: string) {
  return REVIEWERS[reviewer].verdicts[verdict] ?? { label: verdict, tone: "neutral" as const };
}
