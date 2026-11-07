/**
 * 면접 연습 계약(클라이언트·서버 공용): 질문 분류·라벨, 근거 스냅숏(인용 대상 줄), LLM 출력 스키마, API 입력 스키마, 응답 형태.
 * 저장은 PostgreSQL interview_sessions·interview_questions·interview_answers(prisma/schema.prisma) + 저장소 스냅숏
 * users/<userId>/interview/<sessionId>/source.json(InterviewSourceSnapshot). 저장 함수는 src/lib/interview/store.ts.
 *
 * 질문 구성은 작성·면접 가이드(.orca/drops/보고서/종합_작성_및_면접_가이드.md 7장)를 따른다:
 * 서류 한 줄마다 질문 묶음(line), 대표 프로젝트 5단계(project), 빈틈 확인 PIVOT(pivot), 곤란한 질문(tough),
 * 지원 동기·이직 사유·자기소개(motivation), 공고가 없을 때 직무 일반(job).
 */
import { z } from "zod";
import { PORTFOLIO_KINDS } from "./portfolios";

// ---------------------------------------------------------------------------
// 분류
// ---------------------------------------------------------------------------

export const INTERVIEW_QUESTION_CATEGORIES = ["line", "project", "pivot", "tough", "motivation", "job"] as const;
export type InterviewQuestionCategory = (typeof INTERVIEW_QUESTION_CATEGORIES)[number];
export const INTERVIEW_CATEGORY_LABELS: Record<InterviewQuestionCategory, string> = {
  line: "서류 한 줄 질문",
  project: "대표 프로젝트 5단계",
  pivot: "빈틈 확인(PIVOT)",
  tough: "곤란한 질문",
  motivation: "지원 동기·이직 사유",
  job: "직무 일반",
};

/** 서류 한 줄에 붙이는 질문 묶음(가이드 7.6의 10가지 관점). */
export const LINE_FACETS = [
  "why",
  "goal",
  "cause",
  "alternative",
  "ownership",
  "conflict",
  "measure",
  "confound",
  "failure",
  "transfer",
] as const;
/** 대표 프로젝트 5단계(가이드 7.1). */
export const PROJECT_FACETS = ["background", "goal", "problem", "process", "result"] as const;
/** PIVOT(가이드 7.2). */
export const PIVOT_FACETS = ["P", "I", "V", "O", "T"] as const;
/** 곤란한 질문 상황(가이드 7.4). */
export const TOUGH_FACETS = ["number", "team", "failure", "unfamiliar", "counter"] as const;
/** 지원 동기·이직 사유·자기소개(가이드 7.5·7.7). */
export const MOTIVATION_FACETS = ["motivation", "change", "intro"] as const;

export const INTERVIEW_FACETS = {
  line: LINE_FACETS,
  project: PROJECT_FACETS,
  pivot: PIVOT_FACETS,
  tough: TOUGH_FACETS,
  motivation: MOTIVATION_FACETS,
  job: [] as readonly string[],
} as const satisfies Record<InterviewQuestionCategory, readonly string[]>;

export const INTERVIEW_FACET_LABELS: Record<string, string> = {
  why: "필요성",
  goal: "목표·지표",
  cause: "원인 확인",
  alternative: "대안 비교",
  ownership: "본인 역할",
  conflict: "합의 기준",
  measure: "측정 방법",
  confound: "다른 요인",
  failure: "실패·미해결",
  transfer: "지원팀 적용",
  background: "배경",
  problem: "문제 정의",
  process: "과정",
  result: "결과와 회고",
  P: "P · 왜 문제인가",
  I: "I · 왜 그 지표인가",
  V: "V · 왜 그 대안인가",
  O: "O · 어디까지 본인이 했나",
  T: "T · 다른 팀에서 적용",
  number: "숫자가 기억나지 않을 때",
  team: "팀 성과 속 내 몫",
  unfamiliar: "해 보지 않은 일",
  counter: "다른 원인 제시",
  motivation: "지원 동기",
  change: "이직 사유",
  intro: "자기소개",
};

/** facet이 그 분류에 맞는 값인지(job은 facet 없음). 맞지 않으면 null로 저장한다. */
export function normalizeFacet(category: InterviewQuestionCategory, facet: string | null | undefined): string | null {
  if (!facet) return null;
  const allowed = INTERVIEW_FACETS[category] as readonly string[];
  return allowed.includes(facet) ? facet : null;
}

export const INTERVIEW_SESSION_STATUSES = ["generating", "ready", "failed"] as const;
export type InterviewSessionStatus = (typeof INTERVIEW_SESSION_STATUSES)[number];

export const INTERVIEW_QUESTION_STATUSES = ["new", "practiced", "skipped"] as const;
export type InterviewQuestionStatus = (typeof INTERVIEW_QUESTION_STATUSES)[number];

export const INTERVIEW_ANSWER_STATUSES = ["pending", "done", "failed"] as const;
export type InterviewAnswerStatus = (typeof INTERVIEW_ANSWER_STATUSES)[number];

// ---------------------------------------------------------------------------
// 한도
// ---------------------------------------------------------------------------

export const INTERVIEW_LIMITS = {
  /** 세션당 질문 수 상한(LLM 출력 상한과 같다). */
  questionsPerSession: 40,
  /** 사용자당 세션 수 상한. */
  sessionsPerUser: 50,
  /** 질문당 저장하는 답변 수 상한(오래된 것부터 남긴다 — 넘으면 409). */
  answersPerQuestion: 20,
  answerChars: 3000,
  questionChars: 400,
  intentChars: 300,
  followUpChars: 300,
  followUpsPerQuestion: 3,
  citationsPerQuestion: 3,
  quoteChars: 300,
  titleChars: 120,
  /** 스냅숏 줄 하나의 글자 상한(넘으면 자른다). */
  lineChars: 600,
  /** 프롬프트에 넣는 포트폴리오 글자 예산. */
  portfolioPromptChars: 12_000,
  /** 프롬프트에 넣는 JD 글자 예산. */
  jdPromptChars: 8_000,
  /** 답변 시간(초) 입력 상한. */
  durationSec: 600,
} as const;

/** 한국어 말하기 속도 추정(분당 약 300자 ≒ 초당 5자). 답변 길이 피드백·연습 시간 안내용. */
export const KOREAN_SPOKEN_CHARS_PER_SEC = 5;

/** 텍스트 답변을 소리 내어 읽을 때 걸리는 시간(초) 추정. 공백은 세지 않는다. */
export function estimateSpokenSeconds(text: string): number {
  const chars = text.replace(/\s+/g, "").length;
  return Math.round(chars / KOREAN_SPOKEN_CHARS_PER_SEC);
}

/** 질문 분류별 권장 답변 길이(초). 가이드 7.3·7.7: 결론 → 직접 근거 → 한계, 자기소개는 여러 길이. */
export const RECOMMENDED_ANSWER_SECONDS: Record<InterviewQuestionCategory, { min: number; max: number }> = {
  line: { min: 30, max: 90 },
  project: { min: 45, max: 120 },
  pivot: { min: 30, max: 90 },
  tough: { min: 30, max: 90 },
  motivation: { min: 30, max: 90 },
  job: { min: 30, max: 90 },
};

// ---------------------------------------------------------------------------
// 근거 스냅숏(저장소 JSON)
// ---------------------------------------------------------------------------

export const INTERVIEW_SOURCE_DOCS = ["resume", "portfolio", "posting"] as const;
export type InterviewSourceDoc = (typeof INTERVIEW_SOURCE_DOCS)[number];
export const INTERVIEW_SOURCE_DOC_LABELS: Record<InterviewSourceDoc, string> = {
  resume: "이력서",
  portfolio: "포트폴리오",
  posting: "채용 공고",
};

/**
 * 인용할 수 있는 한 줄. id는 세션 안에서 유일하고 짧다: 이력서 'r1'…, 포트폴리오 'p1'…, 공고 'j1'….
 * path는 이력서 문서 안 위치(예: 'experience.0.bullets.2', 'projects.1.result')로 편집기 이동에 쓴다(포트폴리오·공고는 null).
 */
export const InterviewSourceLineSchema = z.object({
  id: z.string().regex(/^[rpj]\d{1,4}$/),
  doc: z.enum(INTERVIEW_SOURCE_DOCS),
  /** 화면 표시용 위치 이름(예: "경력 · 토스 · 대표 기여 3", "포트폴리오 4문단"). */
  label: z.string().max(200),
  path: z.string().max(120).nullable(),
  text: z.string().max(INTERVIEW_LIMITS.lineChars),
});
export type InterviewSourceLine = z.infer<typeof InterviewSourceLineSchema>;

export const InterviewSourceSnapshotSchema = z.object({
  version: z.literal(1),
  resume: z.object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(["company", "general"]),
    company: z.string(),
    roleTitle: z.string(),
    versionId: z.string().nullable(),
    versionNo: z.number().int().nullable(),
  }),
  posting: z
    .object({ id: z.string(), company: z.string(), roleTitle: z.string(), url: z.string() })
    .nullable(),
  portfolio: z
    .object({ kind: z.enum(PORTFOLIO_KINDS), fileName: z.string().nullable(), url: z.string().nullable(), truncated: z.boolean() })
    .nullable(),
  lines: z.array(InterviewSourceLineSchema).max(1500),
  createdAt: z.number(),
});
export type InterviewSourceSnapshot = z.infer<typeof InterviewSourceSnapshotSchema>;

/** 질문의 근거 인용. quote는 그 줄의 일부를 글자 그대로. verified는 서버가 quote ⊂ line.text를 확인한 결과. */
export interface InterviewCitation {
  ref: string;
  doc: InterviewSourceDoc;
  quote: string;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// LLM 출력
// ---------------------------------------------------------------------------

/** task 'interview-questions' 출력. 서버가 분류·facet·인용을 검증·정리한 뒤 저장한다. */
export const InterviewQuestionsOutputSchema = z.object({
  questions: z
    .array(
      z.object({
        category: z.enum(INTERVIEW_QUESTION_CATEGORIES),
        facet: z.string().nullable().describe("분류별 세부 키(line: why·goal…, project: background…, pivot: P·I·V·O·T 등). 없으면 null"),
        question: z.string().describe("면접관이 실제로 물을 한국어 질문 한 문장"),
        intent: z.string().describe("이 질문이 확인하려는 것(한 줄)"),
        citations: z
          .array(z.object({ ref: z.string().describe("근거 줄 id(r1·p3·j2 등)"), quote: z.string().describe("그 줄에서 글자 그대로 옮긴 부분") }))
          .max(INTERVIEW_LIMITS.citationsPerQuestion)
          .describe("질문의 근거가 된 서류 줄. 직무 일반·지원 동기 질문은 비워도 된다"),
        followUps: z.array(z.string()).max(INTERVIEW_LIMITS.followUpsPerQuestion).describe("이어질 꼬리 질문"),
      }),
    )
    .max(INTERVIEW_LIMITS.questionsPerSession),
  notes: z.array(z.string()).max(5).describe("자료에서 비어 있어 질문으로 확인해야 할 점(한국어)"),
});
export type InterviewQuestionsOutput = z.infer<typeof InterviewQuestionsOutputSchema>;

/** 답변 피드백 기준(가이드 7.3·7.6·7.7): 근거·수치·본인 역할·길이·구조. */
export const INTERVIEW_CRITERIA = ["evidence", "numbers", "ownership", "length", "structure"] as const;
export type InterviewCriterion = (typeof INTERVIEW_CRITERIA)[number];
export const INTERVIEW_CRITERIA_LABELS: Record<InterviewCriterion, string> = {
  evidence: "근거",
  numbers: "수치",
  ownership: "본인 역할",
  length: "길이",
  structure: "구조",
};

const CriterionSchema = z.object({
  score: z.number().int().min(1).max(5).describe("1(부족)~5(충분)"),
  comment: z.string().describe("이 기준에서 본 한두 문장 평가"),
});

/**
 * task 'interview-feedback' 출력. 모범 답변 개요는 사용자의 서류·답변에 있는 사실로만 만들고, 없는 사실은 [ADD: ...]로 남긴다.
 */
export const InterviewFeedbackOutputSchema = z.object({
  overall: z.number().int().min(0).max(100).describe("종합 점수(0~100)"),
  criteria: z.object({
    evidence: CriterionSchema,
    numbers: CriterionSchema,
    ownership: CriterionSchema,
    length: CriterionSchema,
    structure: CriterionSchema,
  }),
  strengths: z.array(z.string()).max(3),
  improvements: z.array(z.string()).max(4),
  /** 서류에 없는 주장(확인 필요)으로 보이는 답변 내용. */
  unsupportedClaims: z.array(z.string()).max(3),
  modelAnswer: z.object({
    conclusion: z.string().describe("질문에 바로 답하는 첫 문장"),
    points: z
      .array(z.object({ text: z.string(), ref: z.string().nullable().describe("근거 줄 id. 답변에서만 나온 사실이면 null") }))
      .max(4)
      .describe("근거 순서. 모르는 사실은 [ADD: 확인할 내용]"),
    limitation: z.string().describe("밝힐 한계나 다음 조치. 없으면 빈 문자열"),
  }),
  followUp: z.string().describe("이 답변에 이어 면접관이 물을 꼬리 질문 하나"),
});
export type InterviewFeedbackOutput = z.infer<typeof InterviewFeedbackOutputSchema>;

/** interview_answers.feedback(jsonb)에 저장하는 형태: LLM 출력 + 서버가 잰 길이. */
export interface InterviewFeedback extends InterviewFeedbackOutput {
  answerChars: number;
  estimatedSeconds: number;
  recommendedSeconds: { min: number; max: number };
}

// ---------------------------------------------------------------------------
// API 입력
// ---------------------------------------------------------------------------

const id = z.string().trim().min(1).max(64);

/** POST /api/interview/sessions */
export const CreateInterviewSessionSchema = z.object({
  resumeId: id,
  /** 생략하면 이력서의 현재 버전. */
  versionId: id.nullable().optional(),
  /** 첨부 포트폴리오를 근거에 넣을지(없으면 무시). */
  includePortfolio: z.boolean().optional().default(true),
  /** 생략(undefined)하면 이력서에 연결된 공고, null이면 공고 없이(직무 일반 질문), 값이면 그 보관 공고(소유 확인). */
  postingId: id.nullable().optional(),
  title: z.string().trim().max(INTERVIEW_LIMITS.titleChars).optional(),
  provider: z.string().max(40).nullable().optional(),
});
export type CreateInterviewSessionInput = z.infer<typeof CreateInterviewSessionSchema>;

/** POST /api/interview/sessions/[id]/questions/[qid]/answers */
export const SubmitInterviewAnswerSchema = z.object({
  answer: z.string().trim().min(1, "답변을 입력해 주세요.").max(INTERVIEW_LIMITS.answerChars, `답변은 ${INTERVIEW_LIMITS.answerChars}자 이내로 입력해 주세요.`),
  durationSec: z.number().int().min(0).max(INTERVIEW_LIMITS.durationSec).nullable().optional(),
});
export type SubmitInterviewAnswerInput = z.infer<typeof SubmitInterviewAnswerSchema>;

/** PATCH /api/interview/sessions/[id]/questions/[qid] */
export const UpdateInterviewQuestionSchema = z
  .object({ status: z.enum(INTERVIEW_QUESTION_STATUSES), starred: z.boolean() })
  .partial()
  .refine((v) => v.status !== undefined || v.starred !== undefined, "바꿀 항목이 없습니다.");
export type UpdateInterviewQuestionInput = z.infer<typeof UpdateInterviewQuestionSchema>;

/** PATCH /api/interview/sessions/[id] */
export const RenameInterviewSessionSchema = z.object({ title: z.string().trim().min(1).max(INTERVIEW_LIMITS.titleChars) });

// ---------------------------------------------------------------------------
// 응답
// ---------------------------------------------------------------------------

export interface InterviewSessionSummary {
  id: string;
  title: string;
  resumeId: string | null;
  resumeVersionId: string | null;
  postingId: string | null;
  resumeLabel: string;
  targetLabel: string | null;
  hasPortfolio: boolean;
  hasPosting: boolean;
  status: InterviewSessionStatus;
  error: string | null;
  questionCount: number;
  answeredCount: number;
  createdAt: number;
  updatedAt: number;
  generatedAt: number | null;
}

export interface InterviewAnswerView {
  id: string;
  questionId: string;
  answer: string;
  durationSec: number | null;
  status: InterviewAnswerStatus;
  feedback: InterviewFeedback | null;
  score: number | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface InterviewQuestionView {
  id: string;
  ord: number;
  category: InterviewQuestionCategory;
  facet: string | null;
  question: string;
  intent: string;
  citations: InterviewCitation[];
  followUps: string[];
  status: InterviewQuestionStatus;
  starred: boolean;
  attemptCount: number;
  bestScore: number | null;
  lastAnsweredAt: number | null;
}

export interface InterviewSessionDetail {
  session: InterviewSessionSummary;
  questions: InterviewQuestionView[];
  /** 인용 줄을 화면에 펼쳐 보이기 위한 스냅숏 줄(id → 줄). 생성 중·실패면 빈 배열. */
  sourceLines: InterviewSourceLine[];
  /** 질문별 최근 답변(최대 1개씩). 전체 이력은 질문별 조회로. */
  latestAnswers: Record<string, InterviewAnswerView>;
}

/** 분류별 진행률(화면 요약). */
export interface InterviewProgress {
  total: number;
  practiced: number;
  byCategory: Record<InterviewQuestionCategory, { total: number; practiced: number }>;
  averageBestScore: number | null;
}
