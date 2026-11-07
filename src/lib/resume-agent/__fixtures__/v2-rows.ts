/**
 * v2 단계 행 픽스처(순수): 스키마를 통과하는 최소 출력으로 단계 행을 만든다(next-step-v2·compose·critique 단위 시험).
 */
import { emptyResumeDocument } from "@/lib/domain/resumes";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { sectionStepKey, type SectionId } from "../job-types";
import type { StepRowLike } from "../next-step";
import type { CritiqueStepOutput, EvidencePack, ReviewRound, SectionBrief, SectionFeedback, SectionStepOutput, VerifyReport } from "../schemas";

export const JD_V2: JdAnalysis = {
  source: "jd",
  roleTitle: "백엔드 개발자",
  company: "토스",
  seniority: "주니어",
  summary: "주문·결제 서버",
  mustHave: [
    { id: "R1", text: "Kotlin 기반 서버 개발 경험", category: "skill", jdQuote: "Kotlin 기반 서버 개발 경험" },
    { id: "R2", text: "Kafka 이벤트 파이프라인 운영 경험", category: "skill", jdQuote: "Kafka 이벤트 파이프라인 운영 경험" },
    { id: "R3", text: "Redis 캐시 설계 경험", category: "skill", jdQuote: "Redis 캐시 설계 경험" },
  ],
  niceToHave: [{ id: "R4", text: "AWS 운영 경험", category: "skill", jdQuote: "AWS 운영 경험" }],
  keywords: ["Kotlin", "Kafka", "Redis", "AWS"],
  responsibilities: [],
  hiddenSignals: [],
};

export const EMPTY_VERIFY: VerifyReport = { numbersFlagged: [], dropped: [], corrected: [], riskyClaims: [], retriedForCitations: false };

export const EMPTY_PACK: EvidencePack = {
  version: 1,
  graphFingerprint: "g",
  items: [],
  byRequirement: [],
  coverage: { mustFound: 0, mustTotal: 0, niceFound: 0, niceTotal: 0 },
  truncated: false,
  skillKeys: [],
};

const budget = { items: 4, linesPerItem: 4, chars: 700 };
export const BRIEF_V2: SectionBrief = {
  positioning: "주문 시스템을 다룬 백엔드 개발자",
  headline: "백엔드 개발자",
  requirementMap: [],
  include: { experience: [], projects: [], extras: [] },
  exclude: [],
  keywordPlan: [],
  sectionEmphasis: [],
  gapQuestions: [],
  pageTarget: 1,
  assignments: (["experience", "projects", "highlights", "skills", "extras"] as const).map((section) => ({
    section,
    primaryRequirementIds: section === "experience" ? ["R1", "R2"] : section === "projects" ? ["R3"] : [],
    secondaryRequirementIds: [],
    refs: [],
    angle: "",
    keywords: section === "projects" ? ["Redis"] : [],
    budget,
  })),
  evidenceOwner: [],
  motivation: null,
  summaryAngle: "",
  degraded: false,
  summaryChars: 200,
};

export function row(key: string, output: unknown, status = "done", extra: Partial<StepRowLike> = {}): StepRowLike {
  return { key, kind: key.split(".").at(-1) ?? key, round: Number(/^r(\d)/.exec(key)?.[1] ?? 0), status, output, attempt: 1, ...extra };
}

export function sectionOut(section: SectionId, round: number, over: Partial<SectionStepOutput> = {}): SectionStepOutput {
  return {
    section,
    round,
    fragment: {},
    citations: [],
    notes: [],
    missingInfo: [],
    needEvidence: [],
    coveredRequirementIds: [],
    retried: false,
    carriedFrom: null,
    fallback: null,
    changes: [],
    unchanged: false,
    verify: null,
    suggestion: null,
    skipped: false,
    ...over,
  };
}

export const secRow = (section: SectionId, round: number, status = "done", over: Partial<SectionStepOutput> = {}) =>
  row(sectionStepKey(section, round), status === "done" ? sectionOut(section, round, over) : null, status);

export function composeOut(round: number, over: Record<string, unknown> = {}) {
  const document = emptyResumeDocument();
  document.experience = [{ company: "페이랩", department: "", title: "백엔드 개발자", startDate: "2021.03", endDate: "현재", location: "", scope: "주문 서버", bullets: ["주문 처리"] }];
  return {
    round,
    draft: { document, citations: [], notes: [], missingInfo: [] },
    verify: EMPTY_VERIFY,
    duplicates: [],
    budgetReport: [],
    pages: 0.5,
    previewText: `미리 보기 ${round}`,
    sectionsUsed: [],
    topFallback: false,
    unchanged: false,
    ...over,
  };
}

export function reviewRound(round: number, over: Partial<ReviewRound> = {}): ReviewRound {
  return {
    round,
    verdicts: [],
    passCount: 0,
    passTotal: 3,
    matchScore: 50,
    fitItems: [],
    atsKeywordsMissing: [],
    issues: [{ id: `r${round}-ats-1`, reviewer: "ats", severity: "critical", quote: null, quoteVerified: false, paths: [], issue: "JD 키워드가 이력서에 없습니다: Redis", requirementId: null, needsUserInfo: false }],
    panelScore: 30 + round * 10,
    atsPass: false,
    incomplete: false,
    failedReviewers: [],
    raw: {},
    ...over,
  };
}

export function feedbackFor(section: SectionFeedback["section"], over: Partial<SectionFeedback> = {}): SectionFeedback {
  return { section, score: 50, instructions: ["고쳐라"], issueIds: [], requirementIds: [], keepPaths: [], targetChars: null, quotes: [], keywords: [], ...over };
}

export function critiqueOut(round: number, feedback: SectionFeedback[], over: Partial<CritiqueStepOutput> = {}): CritiqueStepOutput {
  return { round, feedback, composeFeedback: [], questions: [], summary: "피드백", sectionScores: [], fallback: false, pack: null, expand: { added: 0, graphChanged: false, unresolved: [] }, motivation: null, ...over };
}

/** 라운드 0 앞부분(jd·retrieve·brief) 행. */
export function headRows(): StepRowLike[] {
  return [row("r0.jd", { jd: JD_V2, signals: [], reusedFrom: null, jdHash: null }), row("r0.retrieve", { pack: EMPTY_PACK, warnings: [], situation: "general" }), row("r0.brief", { brief: BRIEF_V2, warnings: [] })];
}

export const WAVE1 = ["experience", "projects", "extras", "motivation_suggest"] as const;
export const WAVE2 = ["highlights", "skills", "motivation_draft"] as const;

/** 라운드 0 구역 전부 done + compose. */
export function round0Rows(): StepRowLike[] {
  return [...headRows(), ...[...WAVE1, ...WAVE2].map((s) => secRow(s, 0)), row("r0.compose", composeOut(0))];
}
