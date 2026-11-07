/**
 * 포트폴리오 공개 링크 계약(클라이언트·서버 공용). 소유자가 원할 때만 포트폴리오 하나를 /p/<token>으로 로그인 없이 공개한다.
 * - 공개는 그 순간의 공개본(snapshot)을 따로 저장한다. 이후 비공개로 고친 내용은 '공개본 업데이트' 전까지 공개되지 않는다.
 * - 공개 화면·원본·챗봇은 공개본만 읽는다(소유자의 그래프·이력서·다른 포트폴리오는 읽지 않는다).
 * - 공개를 끄거나 링크를 다시 만들면 옛 주소는 처음부터 없던 주소와 같은 404.
 * 화면·응답에 내부 id(포트폴리오·회원·공유 id)와 이메일을 싣지 않는다.
 */
import { z } from "zod";
import type { PortfolioKind, PortfolioOriginalInfo } from "./portfolios";

/** 공개 주소 토큰: 32바이트 난수(256비트)의 base64url(43자). 이 꼴이 아니면 DB를 보지 않고 404. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isShareTokenShape(token: string): boolean {
  return SHARE_TOKEN_RE.test(token);
}

/** 공개 주소 경로. */
export function portfolioSharePath(token: string): string {
  return `/p/${token}`;
}

/** 이름을 공개하지 않을 때(또는 이름이 비었을 때) 보이는 작성자 표시. */
export const ANONYMOUS_OWNER_LABEL = "포트폴리오 작성자";

/** 공개할 때 고르는 것. */
export interface PortfolioShareOptions {
  /** 내 이름 보이기(기본 꺼짐 → '포트폴리오 작성자'). */
  showName: boolean;
  /** 원본 파일 보기(kind 'file'이고 원본이 있을 때만 뜻이 있다). */
  includeOriginal: boolean;
  /** 방문자 챗봇(기본 켜짐). */
  allowChat: boolean;
  /** 검색 엔진 노출(기본 꺼짐 → noindex). */
  indexable: boolean;
}

export const DEFAULT_SHARE_OPTIONS: PortfolioShareOptions = { showName: false, includeOriginal: true, allowChat: true, indexable: false };

/** POST /api/portfolios/[id]/share — 공개하기·공개본 업데이트(고른 값으로 공개본을 새로 만든다). */
export const PublishPortfolioShareSchema = z.object({
  showName: z.boolean().default(false),
  includeOriginal: z.boolean().default(false),
  allowChat: z.boolean().default(true),
  indexable: z.boolean().default(false),
});

/** PATCH /api/portfolios/[id]/share — 공개본은 그대로 두고 챗봇·검색 노출만 바꾼다. */
export const UpdatePortfolioShareSchema = z
  .object({ allowChat: z.boolean().optional(), indexable: z.boolean().optional() })
  .refine((v) => v.allowChat !== undefined || v.indexable !== undefined, "바꿀 설정을 골라 주세요.");

/** 소유자 화면의 공개 상태(공개 중일 때만). */
export interface PortfolioShareStatus {
  token: string;
  path: string;
  options: PortfolioShareOptions;
  publishedAt: number;
  viewCount: number;
  chatCount: number;
  /** 공개 뒤 포트폴리오(이름·설명·본문·원본)가 바뀌어 공개본과 다르다. */
  outdated: boolean;
}

/** 공개 화면이 받는 공개본(내부 id·이메일 없음). */
export interface PublicPortfolioView {
  title: string;
  description: string | null;
  kind: PortfolioKind;
  /** 그래프: Markdown 본문, 파일: 뽑은 글(없으면 ""), 링크: "". */
  content: string;
  url: string | null;
  ownerLabel: string;
  /** 원본 공개를 고른 파일만. 내용은 GET /api/p/[token]/original. */
  original: PortfolioOriginalInfo | null;
  publishedAt: number;
  allowChat: boolean;
  indexable: boolean;
}

// ---------------------------------------------------------------------------
// 방문자 챗봇
// ---------------------------------------------------------------------------

export const SHARE_CHAT_MAX_QUESTION_CHARS = 500;
/** 화면이 보내는 이전 대화(최근 것부터 이만큼). 서버도 같은 상한으로 자른다. */
export const SHARE_CHAT_MAX_HISTORY = 8;
export const SHARE_CHAT_MAX_HISTORY_MESSAGE_CHARS = 1500;

export const ShareChatRequestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, "질문을 입력해 주세요.")
    .max(SHARE_CHAT_MAX_QUESTION_CHARS, `질문은 ${SHARE_CHAT_MAX_QUESTION_CHARS}자 이내로 입력해 주세요.`),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(SHARE_CHAT_MAX_HISTORY_MESSAGE_CHARS * 2),
      }),
    )
    .max(SHARE_CHAT_MAX_HISTORY * 2, "이전 대화가 너무 깁니다.")
    .default([]),
});
export type ShareChatRequest = z.infer<typeof ShareChatRequestSchema>;

/** 답에 단 근거(공개본의 구역 제목). */
export interface ShareChatCitation {
  label: string;
}

export interface ShareChatResponse {
  answer: string;
  citations: ShareChatCitation[];
  /** 포트폴리오에 답이 없었다. */
  notInPortfolio: boolean;
  /** 범위 밖·남용 요청이라 답하지 않았다. */
  refused: boolean;
}

export const SHARE_CHAT_DISCLAIMER = "AI가 이 포트폴리오 내용만으로 답합니다";

export const SHARE_CHAT_STARTERS = [
  "어떤 프로젝트를 했나요?",
  "가장 큰 성과는 무엇인가요?",
  "주로 쓴 기술은 무엇인가요?",
  "이 포트폴리오를 세 줄로 요약해 주세요",
] as const;
