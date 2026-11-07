/**
 * 그래프 이력서 에이전트의 단일 계약(zod, 클라이언트·서버 공용, 순수). 설계는 docs/RESUME-AGENT.md.
 *
 * - LLM 구조화 출력용 스키마(Llm*)는 문법 크기를 줄이려고 경로·ref 정규식을 느슨하게(z.string().max) 둔다.
 *   서버는 citations.ts·patch.ts에서 엄격한 스키마(DocPath·CitePath·EvidenceRef)로 다시 걸러 저장한다.
 * - 단계 출력(StepOutput)은 모두 여기 스키마를 통과한 JSON만 resume_agent_steps.output에 저장하고, 읽을 때도 이 스키마로 파싱한다
 *   (next-step.ts — 파싱 실패 행은 다시 실행). 스키마를 깨는 변경은 AGENT_SCHEMA_VERSION을 올린다.
 */
import { z } from "zod";
import { NodeLabelSchema } from "@/lib/domain/graph";
import { ResumeDocumentSchema, StoredResumeDocumentSchema } from "@/lib/domain/resumes";
import { FitItemSchema, JdAnalysisSchema, RequirementSchema, ReviewerIdSchema, SituationSchema } from "@/lib/domain/schemas";

/** 단계 출력 스키마 버전. 진행 중 작업의 버전이 다르면 "업데이트로 다시 시작이 필요합니다"로 닫는다. */
export const AGENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// 근거 ref · 문서 경로 · 인용
// ---------------------------------------------------------------------------

/** 근거 ref: 프롬프트에서는 E1, E2 … 짧은 ID만 쓴다. 실제 Neo4j id는 서버의 evidence pack에만 있다. */
export const EvidenceRefSchema = z.string().regex(/^E\d{1,3}$/);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** 문서 경로(줄 단위). citations.ts가 문서에 실제로 있는 경로인지 확인한다. */
export const DOC_PATH_RE =
  /^(summary|basics\.(tagline|totalExperience)|highlights\[\d+\]\.(title|context)|experience\[\d+\]\.(scope|bullets\[\d+\])|projects\[\d+\]\.(summary|problem|action|result|evidence|bullets\[\d+\])|skills\[\d+\]\.detail|extras\[\d+\]\.items\[\d+\]|education\[\d+\]\.note)$/;
export const DocPathSchema = z.string().regex(DOC_PATH_RE);
export type DocPath = z.infer<typeof DocPathSchema>;

/** 항목 경로: 항목의 모든 줄이 이 인용을 물려받는다. */
export const ITEM_PATH_RE = /^(summary|highlights\[\d+\]|experience\[\d+\]|projects\[\d+\]|skills\[\d+\]|extras\[\d+\]\.items\[\d+\]|education\[\d+\]|certifications\[\d+\])$/;
export const CitePathSchema = z.union([DocPathSchema, z.string().regex(ITEM_PATH_RE)]);

export const CitationSchema = z.object({
  path: CitePathSchema,
  refs: z.array(EvidenceRefSchema).min(1).max(8),
  /** 이 항목이 대응하는 JD 요건 ID(R1…). 없으면 빈 배열. */
  requirementIds: z.array(z.string().max(8)).max(6),
});
export type Citation = z.infer<typeof CitationSchema>;

/** LLM 출력용(느슨한) 인용. 서버가 parseCitations로 엄격하게 거른다. */
export const LlmCitationSchema = z.object({
  path: z.string().max(60).describe('항목 경로(예: "experience[0]", "projects[1]", "summary", "skills[0]") 또는 줄 경로(예: "experience[0].bullets[1]")'),
  refs: z.array(z.string().max(6)).max(8).describe("근거 ref(E1…)"),
  requirementIds: z.array(z.string().max(8)).max(6).describe("대응하는 JD 요건 ID(R1…). 없으면 빈 배열"),
});

// ---------------------------------------------------------------------------
// a) JD 분석 — 단계 jd
// ---------------------------------------------------------------------------

export const RequirementSignalSchema = z.object({
  /** R1…(요건) · K1…(요건에 안 묶인 키워드) · T1…(주요 업무) */
  id: z.string(),
  kind: z.enum(["must", "nice", "keyword", "responsibility"]),
  text: z.string(),
  /** 검색 질의(text + jdQuote + 관련 키워드). */
  query: z.string(),
  /** skillKey로 정규화한 기술 키. */
  skills: z.array(z.string()),
  category: RequirementSchema.shape.category.optional(),
});
export type RequirementSignal = z.infer<typeof RequirementSignalSchema>;

export const JdStepOutputSchema = z.object({ jd: JdAnalysisSchema, signals: z.array(RequirementSignalSchema).max(60) });
export type JdStepOutput = z.infer<typeof JdStepOutputSchema>;

// ---------------------------------------------------------------------------
// b) 그래프 검색 — 단계 retrieve
// ---------------------------------------------------------------------------

export const EvidenceItemSchema = z.object({
  ref: EvidenceRefSchema,
  /** Neo4j id(서버 전용 — 프롬프트·뷰·리포트에 넣지 않는다). */
  nodeId: z.string(),
  label: NodeLabelSchema,
  name: z.string(),
  /** "나 → 회사 A → 백엔드 개발자 → 주문 시스템 개편" */
  path: z.string(),
  /** 프롬프트에 들어가는 속성 텍스트(잘린 것). */
  text: z.string(),
  /** "2022.03 ~ 현재" */
  period: z.string(),
  /** 이 노드가 USED_SKILL로 쓴 기술(Skill 노드면 자기 이름). */
  skills: z.array(z.string()),
  hasMetric: z.boolean(),
  completeness: z.number().min(0).max(1),
  /** 뼈대 보정용(Role: 소속 회사·기간, Project·Experience·Education: 기간, Certification: 취득일 = startDate). 그 밖은 null. */
  facts: z
    .object({ company: z.string().nullable(), startDate: z.string(), endDate: z.string(), current: z.boolean() })
    .nullable()
    .default(null),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const EvidencePackSchema = z.object({
  /** retrieve=1, revise의 expand가 근거를 더할 때마다 +1. */
  version: z.number().int(),
  graphFingerprint: z.string(),
  items: z.array(EvidenceItemSchema).max(160),
  byRequirement: z.array(
    z.object({
      requirementId: z.string(),
      refs: z.array(EvidenceRefSchema).max(8),
      skillStatus: z.enum(["proven", "claimed", "missing", "n/a"]),
      topScore: z.number(),
    }),
  ),
  coverage: z.object({ mustFound: z.number(), mustTotal: z.number(), niceFound: z.number(), niceTotal: z.number() }),
  truncated: z.boolean(),
  /** 그래프 전체의 기술 이름(skillKey) — 기술명 검증용. */
  skillKeys: z.array(z.string()).max(400).default([]),
});
export type EvidencePack = z.infer<typeof EvidencePackSchema>;

export const RetrieveStepOutputSchema = z.object({
  pack: EvidencePackSchema,
  warnings: z.array(z.string()).max(10),
  /** 심사 관점: 그래프에 직무(Role)가 없으면 첫 취업. */
  situation: SituationSchema.default("general"),
});
export type RetrieveStepOutput = z.infer<typeof RetrieveStepOutputSchema>;

// ---------------------------------------------------------------------------
// c) 근거 매핑·전략 — 단계 plan
// ---------------------------------------------------------------------------

export const PlanStatusSchema = z.enum(["strong", "partial", "gap"]);

export const ResumeAgentPlanSchema = z.object({
  positioning: z.string().max(300),
  headline: z.string().max(60),
  requirementMap: z.array(
    z.object({
      requirementId: z.string(),
      status: PlanStatusSchema,
      refs: z.array(EvidenceRefSchema).max(6),
      angle: z.string().max(200),
    }),
  ),
  include: z.object({
    experience: z.array(z.object({ ref: EvidenceRefSchema, emphasis: z.enum(["high", "medium", "low"]) })).max(12),
    projects: z.array(z.object({ ref: EvidenceRefSchema, why: z.string().max(160), requirementIds: z.array(z.string()) })).max(6),
    extras: z.array(z.object({ ref: EvidenceRefSchema, reason: z.string().max(120) })).max(8),
  }),
  exclude: z.array(z.object({ ref: EvidenceRefSchema, reason: z.string().max(120) })).max(40),
  keywordPlan: z.array(z.object({ keyword: z.string(), section: z.string(), ref: EvidenceRefSchema })).max(30),
  sectionEmphasis: z.array(z.string().max(160)).max(8),
  gapQuestions: z.array(z.object({ requirementId: z.string(), question: z.string().max(200) })).max(12),
});
export type ResumeAgentPlan = z.infer<typeof ResumeAgentPlanSchema>;

/** plan LLM 출력(ref 정규식 없음 — 서버가 pack 사전으로 거른다). */
const looseRef = z.string().max(6);
export const LlmPlanSchema = z.object({
  positioning: z.string().max(300),
  headline: z.string().max(60),
  requirementMap: z
    .array(z.object({ requirementId: z.string().max(8), status: PlanStatusSchema, refs: z.array(looseRef).max(6), angle: z.string().max(200) }))
    .max(60),
  include: z.object({
    experience: z.array(z.object({ ref: looseRef, emphasis: z.enum(["high", "medium", "low"]) })).max(12),
    projects: z.array(z.object({ ref: looseRef, why: z.string().max(160), requirementIds: z.array(z.string().max(8)).max(10) })).max(6),
    extras: z.array(z.object({ ref: looseRef, reason: z.string().max(120) })).max(8),
  }),
  exclude: z.array(z.object({ ref: looseRef, reason: z.string().max(120) })).max(40),
  keywordPlan: z.array(z.object({ keyword: z.string().max(60), section: z.string().max(40), ref: looseRef })).max(30),
  sectionEmphasis: z.array(z.string().max(160)).max(8),
  gapQuestions: z.array(z.object({ requirementId: z.string().max(8), question: z.string().max(200) })).max(12),
});

export const PlanStepOutputSchema = z.object({ plan: ResumeAgentPlanSchema, warnings: z.array(z.string()).max(10) });
export type PlanStepOutput = z.infer<typeof PlanStepOutputSchema>;

// ---------------------------------------------------------------------------
// d) 초안 — 단계 write_body · write_top
// ---------------------------------------------------------------------------

const Doc = ResumeDocumentSchema;

export const LlmBodyDraftSchema = z.object({
  experience: Doc.shape.experience,
  projects: Doc.shape.projects,
  education: Doc.shape.education,
  certifications: Doc.shape.certifications,
  extras: Doc.shape.extras,
  citations: z.array(LlmCitationSchema).max(60),
  notes: z.array(z.string().max(300)).max(10),
});
export type LlmBodyDraft = z.infer<typeof LlmBodyDraftSchema>;

export const LlmTopDraftSchema = z.object({
  basics: Doc.shape.basics.pick({ headline: true, tagline: true, totalExperience: true }),
  summary: Doc.shape.summary,
  highlights: Doc.shape.highlights,
  skills: Doc.shape.skills,
  citations: z.array(LlmCitationSchema).max(30),
  missingInfo: z.array(z.string().max(300)).max(10),
});
export type LlmTopDraft = z.infer<typeof LlmTopDraftSchema>;

/** 서버가 합친 초안: 문서 + (내부) 인용. 인용은 이력서 저장 시 제거된다. */
export const AgentDraftSchema = z.object({
  // 저장된 단계 출력도 읽어야 하므로 예전 형식 보정(지원 동기 칸 등)을 거친다.
  document: StoredResumeDocumentSchema,
  citations: z.array(CitationSchema).max(200),
  notes: z.array(z.string()).max(20),
  missingInfo: z.array(z.string()).max(30),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export const WriteBodyStepOutputSchema = z.object({ draft: AgentDraftSchema, retriedForCitations: z.boolean() });
export type WriteBodyStepOutput = z.infer<typeof WriteBodyStepOutputSchema>;

// ---------------------------------------------------------------------------
// e) 사실 검증 — verifyDraft
// ---------------------------------------------------------------------------

export const VerifyReportSchema = z.object({
  numbersFlagged: z.array(z.object({ path: z.string(), numbers: z.array(z.string()) })),
  dropped: z.array(z.object({ path: z.string(), text: z.string(), reason: z.enum(["uncited", "invalid_ref", "unknown_skill", "excluded", "trivial_extra", "duplicate_extra"]) })),
  corrected: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })),
  riskyClaims: z.array(z.object({ path: z.string(), text: z.string(), reason: z.enum(["gap_requirement", "ownership", "superlative"]) })),
  retriedForCitations: z.boolean(),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

export const WriteTopStepOutputSchema = z.object({ draft: AgentDraftSchema, verify: VerifyReportSchema, previewText: z.string().max(20_000) });
export type WriteTopStepOutput = z.infer<typeof WriteTopStepOutputSchema>;

// ---------------------------------------------------------------------------
// f) 심사위원 패널 — 단계 review · final_panel
// ---------------------------------------------------------------------------

export const ReviewIssueSchema = z.object({
  /** "r1-manager-1" */
  id: z.string(),
  reviewer: z.union([ReviewerIdSchema, z.literal("fit"), z.literal("verify")]),
  severity: z.enum(["critical", "major", "minor"]),
  quote: z.string().nullable(),
  quoteVerified: z.boolean(),
  paths: z.array(DocPathSchema).max(8),
  issue: z.string(),
  requirementId: z.string().nullable(),
  /** 근거가 그래프에 없어 문장으로 못 고치는 지적(→ 질문). */
  needsUserInfo: z.boolean(),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const VerdictEntrySchema = z.object({ reviewer: ReviewerIdSchema, verdict: z.string(), positive: z.boolean(), oneLiner: z.string() });

export const ReviewRoundSchema = z.object({
  round: z.number().int(),
  verdicts: z.array(VerdictEntrySchema),
  /** 핵심 심사(ats·gatekeeper·manager; full 패널이면 7명) 통과 수. */
  passCount: z.number().int(),
  /** passCount의 분모(핵심 3, full 7). */
  passTotal: z.number().int(),
  matchScore: z.number().int(),
  fitItems: z.array(FitItemSchema),
  atsKeywordsMissing: z.array(z.string()),
  issues: z.array(ReviewIssueSchema).max(80),
  panelScore: z.number().int(),
  atsPass: z.boolean(),
  incomplete: z.boolean(),
  /** 실패한 심사위원(gatekeeper·manager 등). */
  failedReviewers: z.array(z.string()).default([]),
  /** 각 심사위원 원출력(StageOutputs 형태) — 최종 패널 합산·리포트 상세용. 완료 7일 뒤 단계 출력과 함께 지운다. */
  raw: z.record(z.string(), z.unknown()),
});
export type ReviewRound = z.infer<typeof ReviewRoundSchema>;

export const ReviewStepOutputSchema = z.object({ round: ReviewRoundSchema });
export type ReviewStepOutput = z.infer<typeof ReviewStepOutputSchema>;

/** 단계 재시도 때 다시 부르지 않을, 이미 성공한 심사 출력. 단계 실패 시 output에 { partial }로 남긴다. */
export const ReviewPartialSchema = z.object({ partial: z.record(z.string(), z.unknown()) });

export const FinalPanelStepOutputSchema = z.object({
  verdicts: z.array(
    z.object({ reviewer: ReviewerIdSchema, verdict: z.string().nullable(), positive: z.boolean(), oneLiner: z.string() }),
  ),
});
export type FinalPanelStepOutput = z.infer<typeof FinalPanelStepOutputSchema>;

// ---------------------------------------------------------------------------
// g) 수정 — 단계 revise
// ---------------------------------------------------------------------------

export const PATCH_OPS = ["replace", "insert", "remove", "reorder", "addProject", "setSkills"] as const;

/** LLM 출력용(느슨한) 패치. patch.ts가 경로·ref·상한을 검증한다. */
export const LlmRevisePatchSchema = z.object({
  ops: z
    .array(
      z.object({
        op: z.enum(PATCH_OPS),
        path: z.string().max(60).describe("replace·insert·remove의 줄 경로(예: experience[0].bullets[1]). 그 밖이면 빈 문자열"),
        value: z.string().max(600).describe("replace·insert의 새 문장. 그 밖이면 빈 문자열"),
        refs: z.array(z.string().max(6)).max(8).describe("replace·insert·addProject의 근거 ref(E1…)"),
        section: z.string().max(20).describe("reorder의 섹션(experience|projects|highlights|skills). 그 밖이면 빈 문자열"),
        order: z.array(z.number().int()).max(20).describe("reorder의 새 순서(패치 전 인덱스). 그 밖이면 빈 배열"),
        project: ResumeDocumentSchema.shape.projects.element.nullable().describe("addProject의 프로젝트. 그 밖이면 null"),
        skills: ResumeDocumentSchema.shape.skills.nullable().describe("setSkills의 기술 목록. 그 밖이면 null"),
        citations: z.array(LlmCitationSchema).max(30).describe("setSkills의 인용(skills[i])"),
        issueIds: z.array(z.string().max(40)).max(10),
        reason: z.string().max(160),
      }),
    )
    .max(40),
  questions: z.array(z.object({ requirementId: z.string().max(8).nullable(), question: z.string().max(200) })).max(10),
  summary: z.string().max(400),
});
export type LlmRevisePatch = z.infer<typeof LlmRevisePatchSchema>;
export type LlmPatchOp = LlmRevisePatch["ops"][number];

export const ChangeRecordSchema = z.object({
  round: z.number().int(),
  op: z.enum(PATCH_OPS),
  /** reorder는 섹션 이름. */
  path: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  issueIds: z.array(z.string()),
  reviewers: z.array(z.string()),
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

export const ReviseStepOutputSchema = z.object({
  draft: AgentDraftSchema,
  /** expand가 근거를 더했으면 새 pack(아니면 null — 이전 pack 그대로). */
  pack: EvidencePackSchema.nullable(),
  verify: VerifyReportSchema,
  changes: z.array(ChangeRecordSchema).max(60),
  rejectedOps: z.array(z.object({ op: z.string(), path: z.string(), reason: z.string() })).max(40),
  questions: z.array(z.object({ requirementId: z.string().nullable(), question: z.string() })).max(10),
  summary: z.string(),
  expand: z.object({ added: z.number().int(), graphChanged: z.boolean(), unresolved: z.array(z.string()) }),
  /** 유효한 op가 하나도 없었다 → 다음 review 없이 plateau. */
  noop: z.boolean(),
  previewText: z.string().max(20_000),
});
export type ReviseStepOutput = z.infer<typeof ReviseStepOutputSchema>;

// ---------------------------------------------------------------------------
// h) 리포트 — 단계 finalize
// ---------------------------------------------------------------------------

export const STOP_REASONS = ["passed", "plateau", "max_rounds", "only_user_gaps", "budget", "review_failed"] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const AgentReportSchema = z.object({
  version: z.literal(1),
  jd: z.object({
    source: z.enum(["jd", "inferred"]),
    roleTitle: z.string(),
    company: z.string().nullable(),
    mustTotal: z.number(),
    niceTotal: z.number(),
  }),
  rounds: z.array(
    z.object({
      round: z.number(),
      passCount: z.number(),
      passTotal: z.number(),
      matchScore: z.number(),
      panelScore: z.number(),
      atsPass: z.boolean(),
      verdicts: z.array(VerdictEntrySchema),
      changes: z.array(ChangeRecordSchema).max(60),
      summary: z.string(),
    }),
  ),
  chosenRound: z.number(),
  /** 최종본 7명 심사(핵심 3명 = 선택 라운드 재사용 + final_panel 4명). final_panel 실패 독자는 verdict=null. */
  finalPanel: z
    .object({
      passCount: z.number().int(),
      total: z.literal(7),
      verdicts: z.array(z.object({ reviewer: ReviewerIdSchema, verdict: z.string().nullable(), positive: z.boolean(), oneLiner: z.string() })),
    })
    .nullable(),
  stopReason: StopReasonSchema,
  generatedAt: z.string(),
  requirements: z.array(
    z.object({
      requirementId: z.string(),
      text: z.string(),
      must: z.boolean(),
      /** 최종(선택) 라운드 fit 기준. */
      status: z.enum(["met", "partial", "missing"]),
      /** 이 요건을 다룬 이력서 줄(최종 문서에 실제로 있는 줄). */
      resumeLine: z.string().nullable(),
      evidence: z.array(z.object({ name: z.string(), label: NodeLabelSchema, path: z.string() })).max(4),
      inferred: z.boolean(),
    }),
  ),
  gaps: z.array(z.object({ requirementId: z.string().nullable(), question: z.string(), chatPrompt: z.string() })).max(15),
  factCheck: z.object({ numbersFlagged: z.number(), dropped: z.number(), corrected: z.number() }),
  excluded: z.array(z.object({ name: z.string(), reason: z.string() })).max(20),
  notes: z.array(z.string()).max(10),
  graphChanged: z.boolean(),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;

export const FinalizeStepOutputSchema = z.object({ resumeId: z.string(), stopReason: StopReasonSchema });
export type FinalizeStepOutput = z.infer<typeof FinalizeStepOutputSchema>;
