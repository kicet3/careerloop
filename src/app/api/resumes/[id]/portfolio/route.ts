import { featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, RESUME_PORTFOLIO_UPLOAD_LIMIT } from "@/lib/auth/db-rate-limit";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { MAX_PORTFOLIO_CHARS as DIAGNOSIS_PORTFOLIO_CHARS } from "@/lib/diagnoses/form";
import { jsonError } from "@/lib/diagnoses/http";
import { MAX_RESUME_PORTFOLIO_CHARS } from "@/lib/domain/resumes";
import { extractText, IngestError } from "@/lib/ingest/extract";
import { formatMb, uploadLimitsFor, VERCEL_UPLOAD_LIMITS } from "@/lib/ingest/upload-limits";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { getPortfolioText, removePortfolio, setPortfolioFile, setPortfolioUrl } from "@/lib/resumes/portfolio";
import { getResumeMeta } from "@/lib/resumes/service";
import { ResumePortfolioUrlSchema } from "@/lib/resumes/types";

export const runtime = "nodejs";
// PDF·HWP 추출이 길어질 수 있다(extract.ts PDF_TIME_BUDGET_MS 15초).
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** 미리보기 글자 수. */
const PREVIEW_CHARS = 600;

/** 포트폴리오 파일 한 개 상한: 서버 업로드 상한과 4MB(Vercel 요청 본문 4.5MB) 중 작은 값. */
function portfolioLimits() {
  const limits = uploadLimitsFor();
  const perFile = Math.min(limits.perFileBytes, VERCEL_UPLOAD_LIMITS.perFileBytes);
  return { perFile, maxBody: Math.min(limits.maxBodyBytes, VERCEL_UPLOAD_LIMITS.maxBodyBytes) };
}

/**
 * 첨부 정보 + 글자 수 + 앞부분 미리보기. ?include=text면 진단 프리필용 본문(진단 포트폴리오 상한까지)도 싣는다.
 * 포트폴리오가 없으면 { info: null, chars: 0, preview: "" }.
 */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const got = await getPortfolioText(user.id, id);
    if (!got) return resumeNotFound();
    const text = got.text ?? "";
    const includeText = new URL(req.url).searchParams.get("include") === "text";
    return Response.json(
      {
        info: got.info,
        chars: text.length,
        preview: text.slice(0, PREVIEW_CHARS),
        ...(includeText ? { text: text.slice(0, DIAGNOSIS_PORTFOLIO_CHARS) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/portfolio");
  }
}

/**
 * 포트폴리오 붙이기·바꾸기(이력서당 하나 — 있던 파일·URL은 대체).
 * - multipart/form-data: file(PDF·DOCX·HWP·HWPX·HTML·TXT·MD, 4MB 이하). 글만 뽑아 저장하고 원본 파일은 보관하지 않는다.
 *   사용자당 24시간 30회(RESUME_PORTFOLIO_UPLOAD_LIMIT). → { resume, truncated, warnings }
 * - application/json: { url }(http/https). 서버는 그 주소를 열지 않는다. → { resume }
 */
export async function PUT(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    // 본문을 읽기 전에 내 이력서인지 먼저 본다.
    if (!(await getResumeMeta(user.id, id))) return resumeNotFound();
    const contentType = req.headers.get("content-type") ?? "";

    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      const { url } = await readJsonInput(req, ResumePortfolioUrlSchema, 8 * 1024);
      const resume = await setPortfolioUrl(user.id, id, url);
      if (!resume) return resumeNotFound();
      return Response.json({ resume });
    }

    const { perFile, maxBody } = portfolioLimits();
    const limit = await hitDbLimit(RESUME_PORTFOLIO_UPLOAD_LIMIT, user.id);
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
    const f = form.get("file");
    if (!f || typeof f !== "object" || !("arrayBuffer" in f) || f.size === 0) return jsonError("올릴 포트폴리오 파일을 골라 주세요.", 400);
    const file = f as File;
    let extracted: { text: string; warnings: string[] };
    try {
      extracted = await extractText(
        { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
        { maxBytes: perFile, maxChars: MAX_RESUME_PORTFOLIO_CHARS + 1000 },
      );
    } catch (err) {
      if (err instanceof IngestError) return jsonError(err.message, err.status);
      throw err;
    }
    const saved = await setPortfolioFile(user.id, id, { fileName: file.name || "portfolio", text: extracted.text });
    if (!saved) return resumeNotFound();
    const warnings = [...extracted.warnings];
    if (saved.truncated) {
      warnings.push(
        `포트폴리오가 길어 앞부분 ${MAX_RESUME_PORTFOLIO_CHARS.toLocaleString("ko-KR")}자만 저장했습니다. 지원 직무와 관련 있는 부분을 앞에 두면 좋습니다.`,
      );
    }
    return Response.json({ resume: saved.resume, truncated: saved.truncated, warnings });
  } catch (err) {
    return featureErrorResponse(err, "PUT /api/resumes/[id]/portfolio");
  }
}

/** 포트폴리오 떼기(저장한 글도 지운다). → { resume } */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const resume = await removePortfolio(user.id, id);
    if (!resume) return resumeNotFound();
    return Response.json({ resume });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/resumes/[id]/portfolio");
  }
}
