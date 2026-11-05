/**
 * 채팅 계약(클라이언트·서버 공용): 스레드·메시지 타입과 LLM 출력 스키마.
 * - 그래프 채팅(kind='graph'): 사용자가 경험을 이야기하면 LLM이 그래프 변경안(ops)을 내고, 사용자가 확인하면 적용한다.
 * - 심사위원 채팅(kind='reviewer'): 완료된 진단의 심사위원 한 명과, 받은 피드백을 어떻게 고칠지 대화한다.
 * 저장은 src/lib/chat/store.ts(PostgreSQL chat_threads·chat_messages).
 */
import { z } from "zod";
import { type GraphOp, LlmGraphOpSchema, MAX_OPS_PER_BATCH } from "./graph";
import type { ReviewerId } from "./schemas";

export const CHAT_THREAD_KINDS = ["graph", "reviewer"] as const;
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
  /** 경력 그래프 요약(graphToText 결과) */
  careerGraph: "career_graph",
  /** 이력서 원문 (panel/prompts.ts TAGS.resume와 같은 이름) */
  resume: "resume",
  /** 진단 때 낸 포트폴리오 (panel/prompts.ts TAGS.portfolio와 같은 이름) */
  portfolio: "portfolio",
  /** 심사위원이 준 피드백(JSON) */
  reviewerFeedback: "reviewer_feedback",
  /** 채용 공고 페이지 본문(postingPageText 결과, task 'posting-extract') */
  postingPage: "posting_page",
} as const;

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
  /** toGraphOps로 검증을 통과한 연산(적용 대상). */
  ops: GraphOp[];
  summary: string;
  followUpQuestions: string[];
  /** 형식이 틀려 버린 연산의 사유(사용자에게 알릴 수 있다). */
  droppedOps?: string[];
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

export type ChatMessageData = GraphProposalData | ReviewerFeedbackData;

// ---------------------------------------------------------------------------
// API 응답 형태 (날짜는 epoch ms)
// ---------------------------------------------------------------------------

export interface ChatThread {
  id: string;
  kind: ChatThreadKind;
  diagnosisId: string | null;
  reviewer: ReviewerId | null;
  title: string;
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
