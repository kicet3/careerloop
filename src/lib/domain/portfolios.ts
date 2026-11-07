/**
 * 포트폴리오 보관함 계약(클라이언트·서버 공용). 사용자마다 포트폴리오를 여러 개 보관하고(portfolios 테이블), 이력서는 그중
 * 하나를 첨부한다(company_resumes.portfolio_id). 파일은 원본을 보관하지 않고 뽑은 텍스트만 저장소에 두며, 링크는 주소만 저장한다.
 * 'graph'는 경험 그래프에서 AI가 쓴 포트폴리오다(Markdown 본문을 파일 텍스트처럼 저장한다 — 면접 질문·진단 경로가 그대로 읽는다).
 */
import { z } from "zod";
import type { GraphPortfolioSource } from "./graph-portfolio";

export const PORTFOLIO_KINDS = ["file", "url", "graph"] as const;
export type PortfolioKind = (typeof PORTFOLIO_KINDS)[number];

export const MAX_PORTFOLIO_TITLE_CHARS = 120;
/** 사용자가 적는 역할·결과 메모. 진단의 '링크·설명'(5000자)에 주소와 함께 들어가도 넘지 않는 길이. */
export const MAX_PORTFOLIO_DESCRIPTION_CHARS = 2000;
/** 저장하는 텍스트 상한(글자). 넘으면 앞부분만 저장하고 truncated로 알린다. */
export const MAX_PORTFOLIO_TEXT_CHARS = 60_000;
export const MAX_PORTFOLIO_URL_CHARS = 2048;

export interface PortfolioInfo {
  id: string;
  title: string;
  /** 사용자가 적은 역할·결과 메모(없으면 null). */
  description: string | null;
  kind: PortfolioKind;
  /** kind 'file'의 원래 파일 이름. */
  fileName: string | null;
  /** kind 'url'의 주소(http/https). */
  url: string | null;
  /** 저장한 텍스트 글자 수(kind 'file' | 'graph'). */
  chars: number | null;
  /** kind 'graph'의 생성 정보(고른 프로젝트·공고·메모·채울 정보). 그 밖은 null. */
  graphSource: GraphPortfolioSource | null;
  createdAt: number;
  updatedAt: number;
}

/** 이 포트폴리오를 첨부한 이력서(목록·상세 표시용). */
export interface PortfolioResumeRef {
  id: string;
  title: string;
  kind: "company" | "general";
}

export interface PortfolioListItem extends PortfolioInfo {
  resumes: PortfolioResumeRef[];
}

/** 화면의 종류 배지 문구. */
export const PORTFOLIO_KIND_LABELS: Record<PortfolioKind, string> = { file: "파일", url: "링크", graph: "경험 그래프" };

/** 저장소에 본문 텍스트를 두는 종류인지(파일에서 뽑은 글 또는 그래프로 쓴 글). */
export function portfolioHasText(kind: PortfolioKind | string): boolean {
  return kind === "file" || kind === "graph";
}

/** AI가 읽을 수 있는 내용이 있는지(저장한 본문 또는 메모). 링크만 있으면 AI는 열어 보지 못한다. */
export function portfolioReadable(p: Pick<PortfolioInfo, "kind" | "description">): boolean {
  return portfolioHasText(p.kind) || !!p.description?.trim();
}

/** 화면 한 줄 요약: 파일 이름, 주소 또는 '경험 그래프로 만듦'. */
export function portfolioSourceLabel(p: Pick<PortfolioInfo, "kind" | "fileName" | "url">): string {
  if (p.kind === "graph") return "경험 그래프로 만듦";
  return p.kind === "file" ? (p.fileName ?? "파일") : (p.url ?? "링크");
}

/** http/https 주소만 받는다. */
export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export const PortfolioUrlSchema = z
  .string()
  .trim()
  .min(1, "포트폴리오 주소를 입력해 주세요.")
  .max(MAX_PORTFOLIO_URL_CHARS, "주소가 너무 깁니다.")
  .refine(isHttpUrl, "http:// 또는 https:// 로 시작하는 주소를 입력해 주세요.");

export const PortfolioTitleSchema = z
  .string()
  .trim()
  .max(MAX_PORTFOLIO_TITLE_CHARS, `이름은 ${MAX_PORTFOLIO_TITLE_CHARS}자 이내로 입력해 주세요.`);

export const PortfolioDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_PORTFOLIO_DESCRIPTION_CHARS, `설명은 ${MAX_PORTFOLIO_DESCRIPTION_CHARS.toLocaleString("ko-KR")}자 이내로 입력해 주세요.`);

/** POST /api/portfolios (JSON) — 링크로 새 포트폴리오. 파일은 같은 경로에 multipart(file·title·description). */
export const CreatePortfolioUrlSchema = z.object({
  url: PortfolioUrlSchema,
  title: PortfolioTitleSchema.optional(),
  description: PortfolioDescriptionSchema.nullable().optional(),
});
export type CreatePortfolioUrlInput = z.infer<typeof CreatePortfolioUrlSchema>;

/** PATCH /api/portfolios/[id] — 이름·설명 고치기. 이름은 비울 수 없다. */
export const UpdatePortfolioSchema = z
  .object({
    title: PortfolioTitleSchema.min(1, "이름을 입력해 주세요.").optional(),
    description: PortfolioDescriptionSchema.nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.description !== undefined, "바꿀 내용을 입력해 주세요.");
export type UpdatePortfolioInput = z.infer<typeof UpdatePortfolioSchema>;

/** PUT /api/portfolios/[id] (JSON) — 내용을 링크로 바꾸기. 파일은 같은 경로에 multipart(file). */
export const ReplacePortfolioUrlSchema = z.object({ url: PortfolioUrlSchema });

/** PUT /api/portfolios/[id]/text — 저장한 본문 고치기(kind 'graph'). 빈 본문은 받지 않는다. */
export const ReplacePortfolioTextSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "본문을 입력해 주세요.")
    .max(MAX_PORTFOLIO_TEXT_CHARS, `본문은 ${MAX_PORTFOLIO_TEXT_CHARS.toLocaleString("ko-KR")}자 이내로 입력해 주세요.`),
});

/** 고르기 목록(이력서 첨부·새 진단)에 필요한 값만. */
export type PortfolioPickOption = Pick<PortfolioInfo, "id" | "title" | "kind" | "fileName" | "url" | "updatedAt">;

export function toPortfolioPickOption(p: PortfolioInfo): PortfolioPickOption {
  return { id: p.id, title: p.title, kind: p.kind, fileName: p.fileName, url: p.url, updatedAt: p.updatedAt };
}
