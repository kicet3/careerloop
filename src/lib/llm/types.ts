/**
 * 파이프라인이 의존하는 LLM 경계. 구현체는 anthropic.ts(Claude API)와 cli.ts(Claude·ChatGPT 계정 로그인 CLI)다.
 * 파이프라인은 이 인터페이스만 알기 때문에 테스트에서 가짜 클라이언트(src/test/fake-llm.ts)를 주입할 수 있다.
 */
import type { z } from "zod";
import type { StageKey } from "@/lib/domain/schemas";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 파이프라인 밖 기능의 LLM 호출 종류(심사 단계가 아닌 호출). 테스트용 가짜 LLM은 이 값으로 가짜 출력을 고른다.
 * - graph-chat: 경험 그래프 채팅(GraphChatOutputSchema)
 * - reviewer-chat: 심사위원 채팅(ReviewerChatOutputSchema)
 * - resume-draft: 회사별 이력서 초안(ResumeDraftOutputSchema)
 * - portfolio-draft: 경험 그래프 프로젝트 → 포트폴리오(GraphPortfolioOutputSchema, src/lib/portfolios/graph-material.ts)
 * - posting-extract: 채용 공고 페이지 본문에서 회사·직무·마감·구역별 항목 추출(PostingExtractSchema, 구역만이면 PostingSectionsOnlySchema)
 * - posting-translate: 근거 검증을 마친 외국어 공고 항목 → 한국어(PostingTranslationSchema, src/lib/postings/translate.ts)
 * - graph-import: 이력서·포트폴리오 문서 → 그래프 변경안(GraphImportOutputSchema)
 * - graph-repo-import: GitHub 저장소 정보 → 프로젝트 하나의 변경안·후속 질문(GraphRepoImportOutputSchema, src/lib/chat/graph-repo-import.ts)
 * - graph-qa: 그래프에 묻기 답변(GraphQaOutputSchema)
 * - graph-qa-rerank: 그래프에 묻기 후보 관련도 매기기(GraphQaRerankSchema, 선택 단계)
 * - graph-agent-step / -final: 경험 질문하기 에이전트의 스텝(도구 호출 또는 최종 답)·최종 답 강제(src/lib/rag/agent.ts)
 * - graph-agent-entail: 에이전트 최종 답의 보조 함의 검사(선택, RAG_ENTAILMENT=on — 덜어내기 전용)
 * - interview-questions: 이력서·포트폴리오·공고 근거 줄 → 면접 예상 질문(InterviewQuestionsOutputSchema)
 * - interview-feedback: 연습 답변 피드백·모범 답변 개요·꼬리 질문(InterviewFeedbackOutputSchema)
 * - resume-agent-plan / -write / -revise: 그래프 이력서 에이전트의 근거 매핑·초안·수정 패치(src/lib/resume-agent/schemas.ts)
 * - resume-agent-jd / -review: 에이전트가 패널 단계(jd·심사)를 재사용한 호출의 사용량 구분(GenerateRequest.usageTask로만 쓴다)
 * - resume-agent-brief / -section / -compose / -critique / -motivation: 구역별 에이전트(파이프라인 v2)의 총괄 작전·구역 작성·조립·총괄 피드백·
 *   지원 동기 초안·추천(src/lib/resume-agent/schemas.ts, docs/RESUME-SECTION-AGENTS.md)
 * - resume-polish: 이력서 AI로 다듬기 — 한 칸의 대안 문구 2~3개(ResumePolishOutputSchema, src/lib/resumes/polish.ts)·전체 이력서 답변. 도구 루프의 마지막(최종 답 강제) 호출
 * - resume-polish-step: 다듬기 도구 루프의 스텝 — 도구 호출(JD 분석·경험 그래프 조회) 또는 최종 답(src/lib/resumes/polish-tools.ts)
 * - resume-motivation-suggest: 지원 동기 쓸 거리 추천 — 문단은 쓰지 않는다(MotivationSuggestionSchema, src/lib/resumes/motivation.ts)
 * - resume-jd-tips: JD 맞춤 작성 팁 — 공고 요약·구역별 팁·키워드·쓸 만한 경험(JdTipsOutputSchema, src/lib/resumes/jd-tips.ts)
 * - portfolio-share-chat: 공개 포트폴리오 방문자 챗봇 — 공개본만 근거로 답한다(ShareChatOutputSchema, src/lib/portfolios/share-chat.ts). 사용량은 소유자에게 매긴다
 */
export const LLM_TASKS = [
  "graph-chat",
  "reviewer-chat",
  "resume-draft",
  "portfolio-draft",
  "posting-extract",
  "posting-translate",
  "graph-import",
  "graph-repo-import",
  "graph-qa",
  "graph-qa-rerank",
  "graph-agent-step",
  "graph-agent-final",
  "graph-agent-entail",
  "interview-questions",
  "interview-feedback",
  "resume-agent-jd",
  "resume-agent-plan",
  "resume-agent-write",
  "resume-agent-revise",
  "resume-agent-review",
  "resume-agent-brief",
  "resume-agent-section",
  "resume-agent-compose",
  "resume-agent-critique",
  "resume-agent-motivation",
  "resume-polish",
  "resume-polish-step",
  "resume-motivation-suggest",
  "resume-jd-tips",
  "portfolio-share-chat",
] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

interface BaseRequest<T> {
  /** 공통 지시문(페르소나·규칙). 캐시가 잘 되도록 요청마다 바뀌는 값을 넣지 않는다. */
  system: string;
  /** 이 요청에서만 쓰는 자료(이력서·JD·이전 단계 결과·대화). */
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * user 앞부분(STAGE_TASK_DELIMITER 앞, 없으면 전체)에 프롬프트 캐시 지점을 둘지(기본 true, Claude API만 해당).
   * 한 번만 보내고 다시 쓰지 않는 호출(공고 추출 등)은 false로 둬 캐시 쓰기 할증을 피한다.
   */
  cacheUser?: boolean;
}

/** 심사 파이프라인 단계 호출. */
export interface GenerateRequest<T> extends BaseRequest<T> {
  stage: StageKey;
  task?: undefined;
  /** 사용량 기록 task(기본 'diagnosis'). 패널 단계를 진단 밖에서 재사용할 때(이력서 에이전트) 관리자 화면에서 섞이지 않게. */
  usageTask?: LlmTask;
}

/** 파이프라인 밖 기능 호출(채팅·이력서 초안 등). */
export interface TaskRequest<T> extends BaseRequest<T> {
  task: LlmTask;
  stage?: undefined;
}

export type LlmRequest<T> = GenerateRequest<T> | TaskRequest<T>;

/** 로그·오류 메시지용 호출 이름(단계 키 또는 task). */
export function requestLabel(req: LlmRequest<unknown>): string {
  return req.task !== undefined ? req.task : req.stage;
}

export interface GenerateResult<T> {
  output: T;
  usage: LlmUsage;
  /** 실제로 응답한 모델(서버 측 fallback이 동작했으면 대체 모델 이름). */
  model: string;
  /** 모델별 사용량(서버 측 fallback으로 여러 모델이 나눠 쓴 경우 비용을 모델별로 매기기 위함). 없으면 usage 전체를 model로 본다. */
  usageByModel?: ModelUsage[];
}

/** 한 모델이 쓴 토큰. */
export interface ModelUsage {
  model: string;
  usage: LlmUsage;
}

export interface LlmClient {
  readonly name: string;
  generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>>;
}

/**
 * 재시도해도 소용없는 실패(거절, 스키마 불일치 반복 등).
 * - max_tokens: 출력 한도(서버 설정)에서 끊김 — 한도를 올려 한 번 더 시도한 뒤에도 끊긴 경우.
 * - context_window: 입력이 모델 컨텍스트를 넘음 — 입력을 줄여야 한다.
 * - auth: CLI 엔진의 계정 로그인이 없거나 만료됨 — 'AI 연결'에서 다시 로그인해야 한다.
 * - usage_limit: 구독 계정의 사용량 한도에 걸림 — 한도가 풀린 뒤 재시도.
 * - unavailable: CLI가 설치되어 있지 않거나 엔진이 꺼져 있음.
 * - timeout: CLI 호출이 제한 시간 안에 끝나지 않음.
 */
export class LlmPermanentError extends Error {
  /** 실패하기 전까지 이미 쓴 토큰. 실패한 단계의 비용도 진단 사용량에 더한다. */
  usage?: LlmUsage;
  constructor(
    message: string,
    readonly reason:
      | "refusal"
      | "invalid_output"
      | "max_tokens"
      | "context_window"
      | "bad_request"
      | "auth"
      | "usage_limit"
      | "unavailable"
      | "timeout",
    usage?: LlmUsage,
  ) {
    super(message);
    this.name = "LlmPermanentError";
    this.usage = usage;
  }
}

/** 실패한 generate()가 그때까지 쓴 토큰(있으면). 클라이언트 구현체가 오류 객체의 usage 필드에 붙인다. */
export function usageOfError(error: unknown): LlmUsage | null {
  const u = (error as { usage?: unknown } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (k: string) => {
    const v = (u as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  return {
    inputTokens: n("inputTokens"),
    outputTokens: n("outputTokens"),
    cacheReadTokens: n("cacheReadTokens"),
    cacheWriteTokens: n("cacheWriteTokens"),
  };
}

/** 실패한 generate()의 모델별 사용량(있으면). 클라이언트 구현체가 오류 객체의 usageByModel 필드에 붙인다. */
export function usageByModelOfError(error: unknown): ModelUsage[] | null {
  const v = (error as { usageByModel?: unknown } | null)?.usageByModel;
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: ModelUsage[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object" || typeof (item as ModelUsage).model !== "string") return null;
    const u = usageOfError(item);
    if (!u) return null;
    out.push({ model: (item as ModelUsage).model, usage: u });
  }
  return out;
}
