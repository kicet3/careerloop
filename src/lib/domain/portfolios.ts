/**
 * 포트폴리오 보관함 계약(클라이언트·서버 공용). 사용자마다 포트폴리오를 여러 개 보관하고(portfolios 테이블), 이력서는 그중
 * 하나를 첨부한다(company_resumes.portfolio_id). 파일은 올린 원본을 그대로 보관해 화면에 보여 주고(PDF·이미지·DOCX 미리보기, 그 밖은 내려받기),
 * AI(면접 질문·진단)에는 원본에서 뽑은 텍스트만 넘긴다. 링크는 주소만 저장한다.
 * 'graph'는 경험 그래프에서 AI가 쓴 포트폴리오다(Markdown 본문을 파일 텍스트처럼 저장한다 — 면접 질문·진단 경로가 그대로 읽는다).
 */
import { z } from "zod";
import type { GraphPortfolioSource } from "./graph-portfolio";
import { getPortfolioTemplate } from "./portfolio-templates";

export const PORTFOLIO_KINDS = ["file", "url", "graph"] as const;
export type PortfolioKind = (typeof PORTFOLIO_KINDS)[number];

export const MAX_PORTFOLIO_TITLE_CHARS = 120;
/** 사용자가 적는 역할·결과 메모. 진단의 '링크·설명'(5000자)에 주소와 함께 들어가도 넘지 않는 길이. */
export const MAX_PORTFOLIO_DESCRIPTION_CHARS = 2000;
/** 저장하는 텍스트 상한(글자). 넘으면 앞부분만 저장하고 truncated로 알린다. */
export const MAX_PORTFOLIO_TEXT_CHARS = 60_000;
export const MAX_PORTFOLIO_URL_CHARS = 2048;

/** 원본 파일을 화면에 보이는 방식. pdf: 브라우저 PDF 보기, image: 그림, docx: 서버가 HTML로 바꾼 것(격리된 iframe), text: 뽑은 글 + 내려받기, download: 내려받기만. */
export type PortfolioOriginalView = "pdf" | "image" | "docx" | "text" | "download";

/** 보관한 원본 파일 정보(kind 'file'이고 원본을 보관한 항목만). 내용은 GET /api/portfolios/[id]/original(소유자만). */
export interface PortfolioOriginalInfo {
  mime: string;
  size: number;
  view: PortfolioOriginalView;
}

/** 포트폴리오 업로드에서 받는 확장자(이력서·공고 업로드에 이미지를 더한 것 — 이미지는 포트폴리오만 받는다). */
export const PORTFOLIO_UPLOAD_ACCEPT = [".pdf", ".docx", ".hwp", ".hwpx", ".html", ".htm", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp"];

/** 포트폴리오 파일 하나의 기본 상한(MB). 서버는 PORTFOLIO_MAX_UPLOAD_MB로 바꿀 수 있다. */
export const DEFAULT_PORTFOLIO_MAX_UPLOAD_MB = 30;

/**
 * 화면이 쓰는 포트폴리오 업로드 설정(서버가 정해 props로 넘긴다).
 * - maxBytes: 파일 하나의 상한.
 * - directMaxBytes: 서버로 바로(multipart) 보낼 수 있는 상한(Vercel 요청 본문 4.5MB). 넘으면 presigned면 R2에 바로 올린다.
 * - presigned: R2 서명 주소로 바로 올릴 수 있는지(로컬 저장소면 false).
 */
export interface PortfolioUploadConfig {
  maxBytes: number;
  directMaxBytes: number;
  presigned: boolean;
}

/** MIME → 보기 방식. 모르는 값은 내려받기만. */
export function portfolioOriginalView(mime: string | null | undefined): PortfolioOriginalView {
  switch ((mime ?? "").toLowerCase()) {
    case "application/pdf":
      return "pdf";
    case "image/png":
    case "image/jpeg":
    case "image/webp":
      return "image";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "text/plain":
    case "text/markdown":
    case "text/html":
    case "application/x-hwp":
    case "application/hwp+zip":
      return "text";
    default:
      return "download";
  }
}

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
  /** 저장한 텍스트 글자 수(kind 'file' | 'graph'). 글을 뽑지 못한 파일(이미지 등)은 0. */
  chars: number | null;
  /** 보관한 원본 파일(kind 'file'). 원본을 보관하기 전에 올린 항목은 null. */
  original: PortfolioOriginalInfo | null;
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

/**
 * AI가 읽을 수 있는 내용이 있는지(저장한 본문 또는 메모). 링크만 있거나, 글을 뽑지 못한 파일(이미지·스캔 PDF 등, chars 0)만 있으면
 * AI는 내용을 보지 못한다. chars를 모르면(null — 예전 항목) 본문이 있는 것으로 본다.
 */
export function portfolioReadable(p: Pick<PortfolioInfo, "kind" | "description"> & { chars?: number | null }): boolean {
  return (portfolioHasText(p.kind) && p.chars !== 0) || !!p.description?.trim();
}

/** AI가 읽지 못하는 포트폴리오의 안내 문구(portfolioReadable이 false일 때). */
export function portfolioUnreadableHint(p: Pick<PortfolioInfo, "kind">): string {
  return p.kind === "url"
    ? "링크 내용은 AI가 열어 보지 못합니다. 설명에 역할·결과를 적거나 파일로 올리면 면접 질문·진단에 반영됩니다."
    : "이 파일에서는 AI가 읽을 글을 뽑지 못했습니다(이미지·스캔본 등). 원본은 그대로 보이지만, 설명에 역할·결과를 적어야 면접 질문·진단에 반영됩니다.";
}

/** 화면 한 줄 요약: 파일 이름, 주소 또는 '경험 그래프로 만듦'(양식을 알면 '· 양식 이름'). */
export function portfolioSourceLabel(
  p: Pick<PortfolioInfo, "kind" | "fileName" | "url"> & { graphSource?: Pick<GraphPortfolioSource, "templateId"> | null },
): string {
  if (p.kind === "graph") return p.graphSource?.templateId ? `경험 그래프로 만듦 · ${getPortfolioTemplate(p.graphSource.templateId).name}` : "경험 그래프로 만듦";
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

/** R2에 바로 올린 파일의 업로드 id(<꼬리>.<확장자>). POST /api/portfolios/uploads가 준다. */
export const PortfolioUploadIdSchema = z
  .string()
  .regex(/^[a-z0-9]{12,40}\.(pdf|docx|hwp|hwpx|html|txt|md|png|jpg|webp)$/, "업로드 정보가 올바르지 않습니다. 파일을 다시 올려 주세요.");

/** POST /api/portfolios/uploads — 큰 파일을 R2에 바로 올릴 서명 주소 받기. */
export const PortfolioUploadInitSchema = z.object({
  fileName: z.string().trim().min(1, "파일 이름이 없습니다.").max(200, "파일 이름이 너무 깁니다."),
  size: z.number().int().positive("빈 파일입니다."),
});

/** R2에 바로 올린 뒤 마무리(만들기·내용 바꾸기·이력서에 붙이기 공용). */
export const PortfolioUploadFinalizeSchema = z.object({
  uploadId: PortfolioUploadIdSchema,
  fileName: z.string().trim().min(1).max(200),
});

/** POST /api/portfolios (JSON) — 링크로 새 포트폴리오. 파일은 같은 경로에 multipart(file·title·description). */
export const CreatePortfolioUrlSchema = z.object({
  url: PortfolioUrlSchema,
  title: PortfolioTitleSchema.optional(),
  description: PortfolioDescriptionSchema.nullable().optional(),
});
export type CreatePortfolioUrlInput = z.infer<typeof CreatePortfolioUrlSchema>;

/** POST /api/portfolios (JSON) — R2에 바로 올린 파일로 새 포트폴리오. */
export const CreatePortfolioFromUploadSchema = PortfolioUploadFinalizeSchema.extend({
  title: PortfolioTitleSchema.optional(),
  description: PortfolioDescriptionSchema.nullable().optional(),
});

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
