/**
 * 경험 그래프 후속 질문(클라이언트·서버 공용 계약). 저장은 graph_followups(src/lib/chat/followups.ts).
 *
 * 그래프 채팅 변경안이 나올 때 두 가지를 목록에 쌓는다:
 * - question: 변경안의 followUpQuestions(AI가 되물은 질문)
 * - dropped: 변경안에서 뺀 항목 중 사용자가 채울 수 있는 것(문서에 근거 없음, 기간·숫자 형식 오류)을 질문으로 바꾼 것. 중복·잘못된 id·삭제 금지
 *   같은 기술적 사유는 넣지 않는다(src/lib/chat/followup-extract.ts).
 * 프로젝트 단위 대화가 그 프로젝트의 열린 질문을 하나씩 물어 채운다. 답한 변경안을 적용하면 answered, 건너뛰면 skipped(다시 열 수 있다).
 */
import type { ProjectStructureItemId } from "@/lib/graph/project-structure";

export const FOLLOWUP_KINDS = ["question", "dropped"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const FOLLOWUP_STATUSES = ["open", "answered", "skipped"] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

/** 질문 글자 수 상한. */
export const MAX_FOLLOWUP_TEXT_CHARS = 300;
/** 원래 뺀 사유(detail) 글자 수 상한. */
export const MAX_FOLLOWUP_DETAIL_CHARS = 500;
/** 사용자당 열린 후속 질문 상한. 넘으면 새 질문을 쌓지 않는다(오래된 것을 답하거나 건너뛰면 다시 쌓인다). */
export const MAX_OPEN_FOLLOWUPS = 200;

export interface GraphFollowup {
  id: string;
  /** Project 노드 id. null이면 프로젝트 미지정. */
  projectNodeId: string | null;
  threadId: string | null;
  sourceMessageId: string | null;
  kind: FollowupKind;
  text: string;
  /** kind='dropped': 원래 뺀 사유. */
  detail: string | null;
  /** 이 질문이 채우는 프로젝트 구조화 항목(알 때만). */
  targetItem: ProjectStructureItemId | null;
  status: FollowupStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

/** 열린 후속 질문 수: 프로젝트별(Project 노드 id → 개수)과 프로젝트 미지정. */
export interface FollowupCounts {
  byProject: Record<string, number>;
  unassigned: number;
}

/**
 * 사용자 메시지가 후속 질문에 대한 답일 때의 부가 데이터(chat_messages.data). 이 메시지의 답으로 나온 변경안을 적용하면
 * 그 질문을 answered로 바꾼다(GraphProposalData.followupId).
 */
export interface FollowupAnswerData {
  kind: "followup-answer";
  followupId: string;
  /** 보낼 때의 질문 글(화면·프롬프트용). */
  question: string;
}

/** 중복 판정용 정규화: NFKC, 소문자, 공백·문장부호 제거. */
export function normalizeFollowupText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s.,·()\-_/?!'"‘’“”:;~…]+/g, "");
}
