/**
 * 심사 파이프라인의 단일 계약.
 *
 * 각 단계(stage)의 LLM 출력은 여기 정의된 zod 스키마로 구조화 출력(structured output)을 강제하고,
 * DB(diagnosis_stages.output)에는 이 스키마를 통과한 JSON만 저장한다.
 * 웹 보고서와 PDF 보고서는 모두 이 타입에서 만든 ReportModel(report/model.ts)만 소비한다.
 *
 * 규칙: `quote` 필드는 이력서 원문에서 그대로 복사한 문장이어야 한다(검증은 panel/quotes.ts).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 식별자
// ---------------------------------------------------------------------------

/** 심사위원 7명. 순서는 보고서 표시 순서와 같다. */
export const REVIEWER_IDS = [
  "ats", // 서류 자동 필터
  "gatekeeper", // 채용 담당자 (면접 여부 결정)
  "manager", // 팀장
  "rival", // 경쟁 지원자
  "ceo", // 대표
  "recruiter", // 30초 리크루터
  "teammate", // 옆자리 동료
] as const;
export type ReviewerId = (typeof REVIEWER_IDS)[number];
export const ReviewerIdSchema = z.enum(REVIEWER_IDS);

/** 독립적으로 읽는 5명(원본 스킬의 "Five readers, alone"). */
export const READER_IDS = ["manager", "rival", "ceo", "recruiter", "teammate"] as const;
export type ReaderId = (typeof READER_IDS)[number];

/**
 * 파이프라인 단계. 의존 관계:
 *   jd → [ats, gatekeeper, manager, rival, ceo, recruiter, teammate, fit] (병렬)
 *      → synthesis → [rewrite, plan] (병렬) → rescreen(rewrite 의존)
 */
export const STAGE_KEYS = [
  "jd",
  "ats",
  "gatekeeper",
  "manager",
  "rival",
  "ceo",
  "recruiter",
  "teammate",
  "fit",
  "synthesis",
  "rewrite",
  "plan",
  "rescreen",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_DEPENDENCIES: Record<StageKey, readonly StageKey[]> = {
  jd: [],
  ats: ["jd"],
  gatekeeper: ["jd"],
  manager: ["jd"],
  rival: ["jd"],
  ceo: ["jd"],
  recruiter: ["jd"],
  teammate: ["jd"],
  fit: ["jd"],
  synthesis: ["ats", "gatekeeper", "manager", "rival", "ceo", "recruiter", "teammate", "fit"],
  rewrite: ["synthesis"],
  plan: ["synthesis", "fit"],
  rescreen: ["rewrite"],
};

export type StageStatus = "pending" | "running" | "done" | "failed";
export type DiagnosisStatus = "queued" | "running" | "done" | "failed";

/** 지원 상황. 원본 스킬의 프롬프트 템플릿(공고 없음/직무 전환/첫 취업)에 대응. */
export const SITUATIONS = ["general", "career_change", "new_grad", "rewrite_check"] as const;
export type Situation = (typeof SITUATIONS)[number];
export const SituationSchema = z.enum(SITUATIONS);

// ---------------------------------------------------------------------------
// 진단 입력
// ---------------------------------------------------------------------------

export const DiagnosisInputSchema = z.object({
  resumeText: z.string().min(1),
  resumeFileName: z.string().nullable(),
  targetRole: z.string().min(1).max(200),
  /** JD(채용 공고) 원문. 없으면 null — 이때 jd 단계는 직무명으로 요건을 "추정"한다. */
  jdText: z.string().nullable(),
  situation: SituationSchema,
  /** 사용자가 덧붙인 맥락(예: "마케팅에서 데이터 분석으로 전환"). */
  notes: z.string().max(2000).nullable(),
});
export type DiagnosisInput = z.infer<typeof DiagnosisInputSchema>;

// ---------------------------------------------------------------------------
// 공통 조각
// ---------------------------------------------------------------------------

/** 이력서의 특정 줄을 인용한 지적. quote는 원문 그대로. */
export const QuotedIssueSchema = z.object({
  quote: z.string().describe("이력서 원문에서 그대로 복사한 줄. 바꾸거나 요약하지 말 것"),
  issue: z.string().describe("그 줄이 왜 문제인지 한국어 1~2문장"),
});
export type QuotedIssue = z.infer<typeof QuotedIssueSchema>;

// ---------------------------------------------------------------------------
// 1. JD 분석 (stage: jd)
// ---------------------------------------------------------------------------

export const RequirementSchema = z.object({
  id: z.string().describe("R1, R2 ... 형식의 고유 ID"),
  text: z.string().describe("요건 한 줄 요약(한국어)"),
  category: z.enum(["skill", "experience", "education", "domain", "soft", "other"]),
  /** JD 원문 근거. source가 inferred면 null. */
  jdQuote: z.string().nullable(),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const JdAnalysisSchema = z.object({
  /** jd = 사용자가 준 공고에서 추출, inferred = 직무명만으로 추정(보고서에 '추정' 표기). */
  source: z.enum(["jd", "inferred"]),
  roleTitle: z.string(),
  company: z.string().nullable(),
  seniority: z.string().describe("예: 신입, 주니어(1~3년), 시니어(5년+), 리드"),
  summary: z.string().describe("이 포지션이 실제로 원하는 사람을 2~3문장으로"),
  mustHave: z.array(RequirementSchema),
  niceToHave: z.array(RequirementSchema),
  keywords: z.array(z.string()).describe("ATS가 찾을 핵심 용어(도구·기술·자격 등)"),
  responsibilities: z.array(z.string()),
  /** JD 자체의 모호하거나 주의할 점(예: 과도한 요구, 숨은 요구사항). 없으면 빈 배열. */
  hiddenSignals: z.array(z.string()),
});
export type JdAnalysis = z.infer<typeof JdAnalysisSchema>;

// ---------------------------------------------------------------------------
// 2. 서류 자동 필터 (stage: ats, rescreen)
// ---------------------------------------------------------------------------

export const AtsResultSchema = z.object({
  verdict: z.enum(["PASS", "REJECT"]),
  oneLiner: z.string().describe("판정 이유 한 줄(한국어)"),
  reasons: z.array(QuotedIssueSchema).max(5),
  keywordsPresent: z.array(z.string()),
  keywordsMissing: z.array(z.string()),
  /** 위→아래로 읽히는지, 표·다단·이미지 텍스트, 비표준 섹션명 등 파싱 문제. */
  parseIssues: z.array(z.string()),
  contactOk: z.boolean(),
  titlesAndDatesClear: z.boolean(),
});
export type AtsResult = z.infer<typeof AtsResultSchema>;

// ---------------------------------------------------------------------------
// 3. 채용 담당자 (stage: gatekeeper)
// ---------------------------------------------------------------------------

export const GatekeeperResultSchema = z.object({
  verdict: z.enum(["INTERVIEW", "NO"]),
  oneLiner: z.string(),
  firstTenSeconds: z.string().describe("처음 10초에 결정을 가른 것"),
  interviewQuestions: z.array(z.string()).max(5),
  weakestLines: z.array(QuotedIssueSchema).max(3),
});
export type GatekeeperResult = z.infer<typeof GatekeeperResultSchema>;

// ---------------------------------------------------------------------------
// 4. 독립 리뷰어 5명 (stage: manager | rival | ceo | recruiter | teammate)
// ---------------------------------------------------------------------------

export const ReaderResultSchema = z.object({
  verdict: z.enum(["HIRE", "MAYBE", "PASS"]),
  oneLiner: z.string().describe("이 사람의 시선에서 한 줄 평(한국어)"),
  worstLine: QuotedIssueSchema.describe("가장 치명적인 한 줄"),
  otherProblems: z.array(z.string()).max(2),
});
export type ReaderResult = z.infer<typeof ReaderResultSchema>;

// ---------------------------------------------------------------------------
// 5. JD 적합도 매트릭스 (stage: fit)
// ---------------------------------------------------------------------------

export const FitItemSchema = z.object({
  requirementId: z.string().describe("JdAnalysis의 요건 ID"),
  status: z.enum(["met", "partial", "missing"]),
  evidenceQuote: z.string().nullable().describe("근거가 된 이력서 원문 줄. 없으면 null"),
  note: z.string().describe("판단 근거 또는 보완 방법 1문장"),
});
export type FitItem = z.infer<typeof FitItemSchema>;

export const FitResultSchema = z.object({
  /** 0~100. 필수요건 가중치를 우대요건보다 크게. */
  matchScore: z.number().int().min(0).max(100),
  summary: z.string(),
  items: z.array(FitItemSchema),
  /** 이력서에 있지만 JD와 연결 짓지 못한 강점(재배치하면 점수가 오를 것). */
  untappedStrengths: z.array(z.string()),
});
export type FitResult = z.infer<typeof FitResultSchema>;

// ---------------------------------------------------------------------------
// 6. 종합 (stage: synthesis)
// ---------------------------------------------------------------------------

export const MistakeSchema = z.object({
  rank: z.number().int().min(1).describe("1이 가장 심각"),
  title: z.string().describe("문제 요약 한 줄"),
  quote: z.string().nullable().describe("해당 이력서 원문 줄. 이력서 전체에 걸친 문제면 null"),
  why: z.string().describe("이것 때문에 왜 떨어지는지"),
  fix: z.string().describe("어떻게 고칠지 한 줄"),
  severity: z.enum(["critical", "major", "minor"]),
  flaggedBy: z.array(ReviewerIdSchema).min(1),
});
export type Mistake = z.infer<typeof MistakeSchema>;

export const SynthesisResultSchema = z.object({
  headline: z.string().describe("이 이력서의 현재 상태를 한 문장으로"),
  strengths: z.array(z.string()).describe("실제로 먹히는 강점. 아첨 금지, 없으면 빈 배열"),
  mistakes: z.array(MistakeSchema),
  /** 이력서가 강할 때: 가장 거절에 가까웠던 심사위원과, 그래도 버틴 이유. 아니면 null. */
  closestToReject: z
    .object({ reviewer: ReviewerIdSchema, why: z.string() })
    .nullable(),
});
export type SynthesisResult = z.infer<typeof SynthesisResultSchema>;

// ---------------------------------------------------------------------------
// 7. 재작성 (stage: rewrite)
// ---------------------------------------------------------------------------

export const RewriteResultSchema = z.object({
  /** 개선된 이력서 전문(Markdown). 원본 언어 유지. 모르는 사실은 [ADD: 질문] 자리표시. */
  resumeMarkdown: z.string(),
  changes: z.array(
    z.object({
      mistakeRank: z.number().int().nullable(),
      before: z.string().nullable().describe("바꾸기 전 원문 줄. 새로 추가했으면 null"),
      after: z.string(),
    }),
  ),
  /** [ADD: ...] 자리에 대응하는, 사용자에게 물어볼 질문 목록. */
  addQuestions: z.array(z.string()),
  /** 원본에 없어 '추정'으로 처리한 내용. 없으면 빈 배열. */
  assumptions: z.array(z.string()),
});
export type RewriteResult = z.infer<typeof RewriteResultSchema>;

// ---------------------------------------------------------------------------
// 8. 개선 방향성 (stage: plan) — 원본 스킬에는 없는 추가 단계
// ---------------------------------------------------------------------------

export const ImprovementPlanSchema = z.object({
  headline: z.string().describe("가장 중요한 방향 전환 한 문장"),
  /** 이 직무에 대해 자신을 어떤 사람으로 포지셔닝할지 서술(3~5문장). */
  positioning: z.string(),
  priorities: z.array(
    z.object({
      title: z.string(),
      why: z.string(),
      actions: z.array(z.string()).min(1),
      impact: z.enum(["high", "medium", "low"]),
      effort: z.enum(["low", "medium", "high"]),
    }),
  ),
  /** 오늘 바로 고칠 수 있는 것(30분 이내). */
  quickWins: z.array(z.string()),
  sectionGuidance: z.array(
    z.object({
      section: z.string().describe("예: 상단 요약, 경력, 프로젝트, 기술, 학력"),
      direction: z.string(),
    }),
  ),
  /** 이력서 문장으로는 못 메우는 실제 역량 공백과 메우는 방법. */
  skillGaps: z.array(
    z.object({
      skill: z.string(),
      requirementId: z.string().nullable(),
      howToClose: z.string(),
      timeframe: z.string().describe("예: 2주, 1~3개월"),
    }),
  ),
  /** 이 JD/직무에 맞춘 지원 전략(커버레터, 포트폴리오, 추천 등). */
  applicationStrategy: z.array(z.string()),
  interviewPrep: z.array(
    z.object({
      question: z.string(),
      angle: z.string().describe("어떤 사례·숫자로 답할지"),
    }),
  ),
});
export type ImprovementPlan = z.infer<typeof ImprovementPlanSchema>;

// ---------------------------------------------------------------------------
// 단계 → 스키마/출력 타입 매핑
// ---------------------------------------------------------------------------

export const STAGE_SCHEMAS = {
  jd: JdAnalysisSchema,
  ats: AtsResultSchema,
  gatekeeper: GatekeeperResultSchema,
  manager: ReaderResultSchema,
  rival: ReaderResultSchema,
  ceo: ReaderResultSchema,
  recruiter: ReaderResultSchema,
  teammate: ReaderResultSchema,
  fit: FitResultSchema,
  synthesis: SynthesisResultSchema,
  rewrite: RewriteResultSchema,
  plan: ImprovementPlanSchema,
  rescreen: AtsResultSchema,
} as const satisfies Record<StageKey, z.ZodType>;

export type StageOutputs = { [K in StageKey]: z.infer<(typeof STAGE_SCHEMAS)[K]> };
