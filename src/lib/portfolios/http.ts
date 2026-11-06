import "server-only";
/**
 * 포트폴리오 라우트 공용(/api/portfolios·/api/resumes/[id]/portfolio): 파일 업로드 읽기(레이트 리밋 → 크기 제한 → 텍스트 추출),
 * 업로드 상한, 404·잘림 경고 문구.
 */
import { hitDbLimit, PORTFOLIO_UPLOAD_LIMIT } from "@/lib/auth/db-rate-limit";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { jsonError } from "@/lib/diagnoses/http";
import { MAX_PORTFOLIO_TEXT_CHARS, PortfolioDescriptionSchema, PortfolioTitleSchema } from "@/lib/domain/portfolios";
import { extractText, IngestError } from "@/lib/ingest/extract";
import { formatMb, uploadLimitsFor, VERCEL_UPLOAD_LIMITS } from "@/lib/ingest/upload-limits";
import { parseJsonInput } from "@/lib/resumes/http";
import { PORTFOLIO_NOT_FOUND } from "./service";

export const portfolioNotFound = () => jsonError(PORTFOLIO_NOT_FOUND, 404);

/** 포트폴리오 파일 한 개 상한: 서버 업로드 상한과 4MB(Vercel 요청 본문 4.5MB) 중 작은 값. */
export function portfolioUploadLimits(): { perFile: number; maxBody: number } {
  const limits = uploadLimitsFor();
  return {
    perFile: Math.min(limits.perFileBytes, VERCEL_UPLOAD_LIMITS.perFileBytes),
    maxBody: Math.min(limits.maxBodyBytes, VERCEL_UPLOAD_LIMITS.maxBodyBytes),
  };
}

export function isMultipart(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

export interface PortfolioUpload {
  fileName: string;
  text: string;
  warnings: string[];
  /** 폼의 title·description(새로 만들 때만 쓴다). 비었으면 undefined. */
  title?: string;
  description?: string;
}

function formString(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * multipart 업로드(file + 선택 title·description)를 읽어 텍스트를 뽑는다. 사용자당 24시간 PORTFOLIO_UPLOAD_LIMIT회(본문을 읽기 전에 센다).
 * 실패하면 그대로 돌려줄 Response(429·413·400·415 등). 이름·설명 검증 실패는 FeatureError(400).
 */
export async function readPortfolioUpload(req: Request, userId: string): Promise<PortfolioUpload | Response> {
  const { perFile, maxBody } = portfolioUploadLimits();
  const limit = await hitDbLimit(PORTFOLIO_UPLOAD_LIMIT, userId);
  if (!limit.ok) {
    return Response.json(
      { error: "오늘 올릴 수 있는 포트폴리오 파일 수를 넘었습니다. 내일 다시 시도하거나 링크로 붙여 주세요." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }
  let form: FormData;
  try {
    form = await readFormDataLimited(req, maxBody);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(`파일이 너무 큽니다. ${formatMb(perFile)} 이하 파일만 올릴 수 있습니다.`, 413);
    return jsonError("요청 형식이 올바르지 않습니다. multipart/form-data로 보내 주세요.", 400);
  }
  const title = formString(form, "title");
  const description = formString(form, "description");
  if (title !== undefined) parseJsonInput(PortfolioTitleSchema, title);
  if (description !== undefined) parseJsonInput(PortfolioDescriptionSchema, description);
  const f = form.get("file");
  if (!f || typeof f !== "object" || !("arrayBuffer" in f) || f.size === 0) return jsonError("올릴 포트폴리오 파일을 골라 주세요.", 400);
  const file = f as File;
  try {
    const extracted = await extractText(
      { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      { maxBytes: perFile, maxChars: MAX_PORTFOLIO_TEXT_CHARS + 1000 },
    );
    return { fileName: file.name || "portfolio", text: extracted.text, warnings: [...extracted.warnings], title, description };
  } catch (err) {
    if (err instanceof IngestError) return jsonError(err.message, err.status);
    throw err;
  }
}

export function truncatedWarning(): string {
  return `포트폴리오가 길어 앞부분 ${MAX_PORTFOLIO_TEXT_CHARS.toLocaleString("ko-KR")}자만 저장했습니다. 지원 직무와 관련 있는 부분을 앞에 두면 좋습니다.`;
}

/** 미리보기 글자 수. */
export const PORTFOLIO_PREVIEW_CHARS = 600;
