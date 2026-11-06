/**
 * 채팅 계약(클라이언트·서버 공용): 스레드·메시지 타입과 LLM 출력 스키마.
 * - 그래프 채팅(kind='graph'): 사용자가 경험을 이야기하면 LLM이 그래프 변경안(ops)을 내고, 사용자가 확인하면 적용한다.
 * - 심사위원 채팅(kind='reviewer'): 완료된 진단의 심사위원 한 명과, 받은 피드백을 어떻게 고칠지 대화한다.
 * 저장은 src/lib/chat/store.ts(PostgreSQL chat_threads·chat_messages).
 */
import { z } from "zod";
import type { ExperienceCategoryId } from "./experience-categories";
import type { FollowupAnswerData } from "./followups";
import { type GraphOp, LlmGraphOpSchema, MAX_OPS_PER_BATCH, type NodeLabel, type RelType } from "./graph";
import type { ReviewerId } from "./schemas";

/**
 * - graph: 그래프 만들기 채팅(변경안 제안)
 * - reviewer: 심사위원 채팅
 * - graph-qa: 그래프에 묻기(그래프 근거 Q&A, 출처 표기) — docs/GRAPH-QA.md
 */
export const CHAT_THREAD_KINDS = ["graph", "reviewer", "graph-qa"] as const;
export type ChatThreadKind = (typeof CHAT_THREAD_KINDS)[number];
export type ChatRole = "user" | "assistant";

/** 메시지 처리 상태. 변경안이 있는 assistant 메시지만 쓰고 일반 메시지는 null. */
export const CHAT_MESSAGE_STATUSES = ["proposed", "applied", "dismissed", "failed"] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

/** 사용자 메시지 길이 상한(글자). */
export const MAX_CHAT_MESSAGE_CHARS = 4000;
export const ChatUserMessageSchema = z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS);

/**
 * 채팅 프롬프트(user 메시지)의 자료 태그. 기능 모듈은 이 태그로 자료를 감싸고(panel/prompts.ts의 neutralize로 태그 무력화),
 * 테스트용 가짜 LLM(src/test/fake-llm.ts)은 같은 태그에서 자료를 읽어 결정적 가짜 출력을 만든다.
 */
export const CHAT_TAGS = {
  /** 이번 사용자 메시지 원문 */
  latestMessage: "latest_message",
  /** 이전 대화(historyToPrompt 결과) */
  conversation: "conversation",
  /** 경험 그래프 요약(graphToText 결과) */
  careerGraph: "career_graph",
  /** 이력서 원문 (panel/prompts.ts TAGS.resume와 같은 이름) */
  resume: "resume",
  /** 진단 때 낸 포트폴리오 (panel/prompts.ts TAGS.portfolio와 같은 이름) */
  portfolio: "portfolio",
  /** 심사위원이 준 피드백(JSON) */
  reviewerFeedback: "reviewer_feedback",
  /** 채용 공고 페이지 본문(postingPageText 결과, task 'posting-extract') */
  postingPage: "posting_page",
  /** 경험 체크리스트(checklistToPromptText 결과) */
  experienceChecklist: "experience_checklist",
  /** 프로젝트 단위 대화: 구조화할 프로젝트와 그 주변 그래프·구조화 체크리스트(graph/project-structure.ts projectFocusText) */
  focusProject: "focus_project",
  /** 후속 질문: 이번 메시지가 답하는 질문과(있으면) 그 프로젝트의 남은 열린 질문(graph-chat.ts followupBlock) */
  followupQuestions: "followup_questions",
  /** 그래프에 묻기: 번호를 붙인 근거 노드 표(qa-context.ts buildContext), LLM 리랭크 후보 표 */
  graphSources: "graph_sources",
  /** 면접 연습: id를 붙인 근거 줄 표(`[r1] (이력서 · 위치) 본문` 한 줄씩, domain/interview.ts InterviewSourceLine) */
  interviewSources: "interview_sources",
  /** 면접 연습: 연습 중인 질문(분류·의도·꼬리 질문 포함) */
  interviewQuestion: "interview_question",
  /** 면접 연습: 사용자의 답변 원문 */
  interviewAnswer: "interview_answer",
} as const;

/** 이력서·포트폴리오 가져오기: 한 번에 다루는 문서 글자 수, 변경안 연산 수 상한(직접 편집·채팅은 MAX_OPS_PER_BATCH). */
export const MAX_IMPORT_CHARS = 20_000;
export const MAX_IMPORT_OPS = 150;
/** 그래프에 묻기: 질문 길이 상한(글자). */
export const MAX_QA_QUESTION_CHARS = 1000;
export const DOC_KINDS = ["resume", "portfolio"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

// ---------------------------------------------------------------------------
// LLM 출력
// ---------------------------------------------------------------------------

/** 그래프 채팅 LLM 출력. 모르는 사실은 ops에 지어 넣지 않고 followUpQuestions로 되묻는다. */
export const GraphChatOutputSchema = z.object({
  reply: z.string().describe("사용자에게 보일 한국어 답변(변경안 설명 포함). 짧게"),
  ops: z.array(LlmGraphOpSchema).max(MAX_OPS_PER_BATCH).describe("그래프 변경안. 바꿀 것이 없으면 []"),
  summary: z.string().describe('변경안 한 줄 요약. ops가 비었으면 ""'),
  followUpQuestions: z.array(z.string()).max(3).describe("그래프를 채우려고 사용자에게 되물을 질문(최대 3개)"),
});
export type GraphChatOutput = z.infer<typeof GraphChatOutputSchema>;

/** 이력서·포트폴리오 가져오기 LLM 출력: 그래프 채팅과 같은 모양이고 연산 상한만 크다. */
export const GraphImportOutputSchema = z.object({
  reply: z.string().describe("문서에서 무엇을 정리했는지 짧게(한국어)"),
  ops: z.array(LlmGraphOpSchema).max(MAX_IMPORT_OPS).describe("그래프 변경안. 문서에 글자로 있는 사실만"),
  summary: z.string().describe("변경안 한 줄 요약"),
  followUpQuestions: z.array(z.string()).max(3).describe("문서에 없어 비워 둔 기간·수치·역할 등을 묻는 질문(최대 3개)"),
});
export type GraphImportOutput = z.infer<typeof GraphImportOutputSchema>;

/** 그래프에 묻기 답변 LLM 출력. node id는 내지 않고 자료 번호만 낸다(번호→노드 표는 서버가 갖는다). */
export const GraphQaOutputSchema = z.object({
  answer: z.string().describe("한국어 답. 사실 문장마다 끝에 [번호]. 자료에 없으면 없다고 말한다"),
  usedSources: z.array(z.number().int()).max(12).describe("답에서 인용한 자료 번호"),
  insufficient: z.boolean().describe("자료만으로 질문에 충분히 답할 수 없으면 true"),
  missingInfo: z.array(z.string()).max(3).describe("답하려면 그래프에 더 필요한 정보(최대 3개)"),
});
export type GraphQaOutput = z.infer<typeof GraphQaOutputSchema>;

/** 그래프에 묻기 LLM 리랭크 출력(선택 단계). 후보 id(c1…)마다 관련도 0~3. */
export const GraphQaRerankSchema = z.object({
  ratings: z
    .array(
      z.object({
        id: z.string().describe("후보 id(c1, c2, …)"),
        relevance: z.number().int().min(0).max(3).describe("0 무관, 1 약간, 2 관련, 3 질문에 직접 답함"),
      }),
    )
    .max(20),
});
export type GraphQaRerankOutput = z.infer<typeof GraphQaRerankSchema>;

export const SuggestedEditSchema = z.object({
  before: z.string().nullable().describe("고칠 이력서 원문(글자 그대로 인용). 새로 추가하는 내용이면 null"),
  after: z.string().describe("고친 문장. 모르는 사실은 [ADD: 질문]으로 남긴다"),
  reason: z.string().describe("이 심사위원의 기준에서 왜 이렇게 고치는지"),
});
export type SuggestedEdit = z.infer<typeof SuggestedEditSchema>;

/** 심사위원 채팅 LLM 출력. */
export const ReviewerChatOutputSchema = z.object({
  reply: z.string().describe("심사위원으로서의 한국어 답변"),
  suggestedEdits: z.array(SuggestedEditSchema).max(5),
  followUpQuestions: z.array(z.string()).max(3).describe("더 정확히 조언하려고 지원자에게 물을 질문"),
  verdictOutlook: z.string().nullable().describe("제안대로 고치면 이 심사위원의 판단이 어떻게 바뀔지(추정). 해당 없으면 null"),
});
export type ReviewerChatOutput = z.infer<typeof ReviewerChatOutputSchema>;

// ---------------------------------------------------------------------------
// 메시지 부가 데이터 (chat_messages.data)
// ---------------------------------------------------------------------------

export interface GraphProposalData {
  kind: "graph-proposal";
  /** 이력서·포트폴리오 가져오기에서 나온 변경안이면 "document-import"(적용 상한이 MAX_IMPORT_OPS). */
  source?: "chat" | "document-import";
  /** toGraphOps로 검증을 통과한 연산(적용 대상). */
  ops: GraphOp[];
  summary: string;
  followUpQuestions: string[];
  /** 형식이 틀려 버린 연산의 사유(사용자에게 알릴 수 있다). */
  droppedOps?: string[];
  /** droppedOps 중 후속 질문 목록(graph_followups)에 질문으로 넣은 것의 번호(0부터). */
  droppedFollowups?: number[];
  /** 이 변경안이 답한 후속 질문 id(사용자 메시지의 FollowupAnswerData). 적용하면 그 질문을 answered로 바꾼다. */
  followupId?: string;
  /** 적용 결과(status='applied'일 때): 임시 ref → 새 노드 id. */
  created?: Record<string, string>;
  /** 적용 실패 사유(status='failed'일 때). */
  error?: string;
}

export interface ReviewerFeedbackData {
  kind: "reviewer-feedback";
  suggestedEdits: (SuggestedEdit & { /** before가 이력서 원문과 일치하는지(verifyQuote). */ quoteVerified?: boolean })[];
  followUpQuestions: string[];
  verdictOutlook: string | null;
}

/** 이력서·포트폴리오 가져오기 사용자 메시지. 원본 파일은 저장하지 않고 읽어 낸 글만 둔다. */
export interface DocumentImportData {
  kind: "document-import";
  docKind: DocKind;
  fileName: string | null;
  /** 읽어 낸 글(MAX_IMPORT_CHARS 이하). 화면용 응답에서는 비운다. */
  text: string;
  chars: number;
  truncated: boolean;
  warnings: string[];
}

/** 출처 경로 한 단계: 앞 단계에서 이 단계로 온 관계(rel, 첫 단계는 null). */
export interface GraphPathStep {
  id: string;
  label: NodeLabel | "Person";
  name: string;
  rel: RelType | null;
}

/** 답변 출처: 그래프 노드와 본인(Person)에서 그 노드까지의 경로. */
export interface GraphSource {
  /** 답에서 쓴 번호([n]). */
  n: number;
  nodeId: string;
  label: NodeLabel;
  name: string;
  path: GraphPathStep[];
  /** "나 → 페이랩(회사) → 백엔드 개발자(직무) → …" */
  pathText: string;
  /** 근거 속성 요약(200자 이하). */
  snippet: string;
  /** 조회 때 다시 확인한 존재 여부(삭제된 노드면 false). */
  exists?: boolean;
}

export interface GraphAnswerSuggestion {
  categoryId: ExperienceCategoryId;
  name: string;
  chatStarter: string;
}

/** 검색·리랭크 디버그 정보(개발 환경에서만 저장·반환). */
export interface RetrievalDebug {
  intents: string[];
  skills: string[];
  tags: string[];
  fallback: boolean;
  pool: { id: string; name: string; label: string; signals: Record<string, number>; det: number; llm?: number; final: number }[];
  llmRerank: { used: boolean; reason?: string; ms?: number };
  contextChars: number;
}

export interface GraphAnswerData {
  kind: "graph-answer";
  /** 답에서 실제 인용한 출처만(번호는 컨텍스트 번호 그대로). */
  sources: GraphSource[];
  insufficient: boolean;
  /** 유효한 인용이 하나 이상. */
  grounded: boolean;
  missingInfo: string[];
  /** 그래프를 채울 제안(체크리스트 기반, 서버가 정한다). */
  suggestions: GraphAnswerSuggestion[];
  /** 지운 무효 인용 번호. */
  droppedCitations?: number[];
  debug?: RetrievalDebug;
}

export type ChatMessageData = GraphProposalData | ReviewerFeedbackData | GraphAnswerData | DocumentImportData | FollowupAnswerData;

// ---------------------------------------------------------------------------
// API 응답 형태 (날짜는 epoch ms)
// ---------------------------------------------------------------------------

export interface ChatThread {
  id: string;
  kind: ChatThreadKind;
  diagnosisId: string | null;
  reviewer: ReviewerId | null;
  title: string;
  /** 프로젝트 단위 그래프 채팅이면 집중하는 Project 노드 id. 일반 대화는 null. */
  focusNodeId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string;
  data: ChatMessageData | null;
  status: ChatMessageStatus | null;
  createdAt: number;
}
