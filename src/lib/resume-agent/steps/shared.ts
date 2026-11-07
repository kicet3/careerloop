/**
 * 단계 공용: 실행 맥락·결과·오류 분류, 심사 입력(PanelInput) 만들기, 심사용 렌더.
 * 그래프는 ctx.loadGraph(= evidence.ts loadAgentGraph)로만 읽는다. 심사 단계의 JD는 같은 작업의 r0.jd 행에서만 읽는다.
 */
import type { CareerGraph } from "@/lib/domain/graph";
import type { ResumeDocument, ResumeTemplateId } from "@/lib/domain/resumes";
import type { Situation } from "@/lib/domain/schemas";
import type { UsageTotals } from "@/lib/db/types";
import type { GenerateResult, LlmClient, LlmUsage } from "@/lib/llm/types";
import type { PanelInput } from "@/lib/panel/prompts";
import { resumeToText } from "@/lib/resumes/layout";
import type { CreateResumeInput } from "@/lib/resumes/types";
import type { AgentSettings } from "../config";
import type { StepRowLike } from "../next-step";

export type AgentInput = CreateResumeInput;

export interface StepContext {
  job: { id: string; userId: string; input: AgentInput };
  rows: readonly StepRowLike[];
  llm: LlmClient;
  signal: AbortSignal;
  settings: AgentSettings;
  /** 그래프 읽기(작업 행 userId로만 — evidence.ts loadAgentGraph). */
  loadGraph: (job: { userId: string }) => Promise<CareerGraph>;
  nowYear?: number;
  /** 같은 단계 이전 시도의 출력(심사의 partial 재사용). */
  previousOutput: unknown;
}

export interface StepResult<T = unknown> {
  output: T;
  summary: string[];
  usage: UsageTotals;
  model: string | null;
}

/**
 * 단계 실패. permanent면 재시도하지 않는다(그래프 부족·영구 LLM 오류). partial이 있으면 단계 행 output에 남겨 다음 시도가 재사용한다.
 */
export class AgentStepError extends Error {
  constructor(
    readonly code: "insufficient_graph" | "draft_empty" | "review_incomplete" | "missing_input" | "final_panel_failed",
    message: string,
    readonly permanent: boolean,
    readonly partial?: unknown,
    readonly usage?: UsageTotals,
  ) {
    super(message);
    this.name = "AgentStepError";
  }
}

export const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: UsageTotals, b: LlmUsage | UsageTotals | null | undefined): UsageTotals {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** 여러 호출의 사용량·모델을 모은다. */
export class UsageMeter {
  usage: UsageTotals = { ...ZERO_USAGE };
  model: string | null = null;
  take<T>(r: GenerateResult<T>): T {
    this.usage = addUsage(this.usage, r.usage);
    this.model = r.model || this.model;
    return r.output;
  }
}

/** 심사 입력. 지원 직무는 직무명만, 회사는 메모로(진단 입력과 같은 방식). 연락처·이름은 넣지 않는다. */
export function panelInputFor(input: AgentInput, resumeText: string, situation: Situation): PanelInput {
  const general = input.kind === "general";
  const company = general ? "" : input.company.trim();
  const role = general ? "" : input.roleTitle.trim();
  return {
    resumeText,
    resumeFileName: null,
    targetRole: role || "지원 직무(공용 이력서 — 자료에서 가장 잘 드러나는 직무)",
    jdText: general ? null : input.jdText.trim() || null,
    situation,
    notes: company ? `지원 회사: ${company}` : null,
    draftMode: true,
  };
}

/** 심사용 렌더: 이름은 "지원자", 메일은 자리표시(실제 값은 LLM에 보내지 않는다). */
export function reviewText(doc: ResumeDocument, templateId: ResumeTemplateId): string {
  const d = structuredClone(doc);
  d.basics.name = "지원자";
  d.basics.email = "[계정 메일 — 저장 시 채움]";
  d.basics.phone = "";
  d.basics.links = [];
  d.basics.portfolioUrl = "";
  return resumeToText(d, templateId);
}

/** 진행 화면 미리 보기(이름·연락처 없음). */
export function previewText(doc: ResumeDocument, templateId: ResumeTemplateId): string {
  const d = structuredClone(doc);
  d.basics.name = "";
  d.basics.email = "";
  d.basics.phone = "";
  return resumeToText(d, templateId).slice(0, 20_000);
}

export function agentPromptContext(input: AgentInput): { company: string; roleTitle: string; templateId: ResumeTemplateId } {
  const general = input.kind === "general";
  return { company: general ? "" : input.company, roleTitle: general ? "" : input.roleTitle, templateId: input.templateId };
}
