import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { MAX_PORTFOLIO_CHARS as DIAGNOSIS_PORTFOLIO_CHARS } from "@/lib/diagnoses/form";
import type { PortfolioInfo } from "@/lib/domain/portfolios";
import { isMultipart, PORTFOLIO_PREVIEW_CHARS, portfolioNotFound, readPortfolioUpload, truncatedWarning } from "@/lib/portfolios/http";
import { createPortfolioFromFile, createPortfolioFromUrl } from "@/lib/portfolios/service";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { attachPortfolio, detachPortfolio, getResumePortfolioText } from "@/lib/resumes/portfolio";
import { getResumeMeta } from "@/lib/resumes/service";
import { ResumePortfolioAttachSchema } from "@/lib/resumes/types";

export const runtime = "nodejs";
// PDF·HWP 추출이 길어질 수 있다(extract.ts PDF_TIME_BUDGET_MS 15초).
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/**
 * 첨부 정보(보관함 포트폴리오, 설명 포함) + 글자 수 + 앞부분 미리보기. ?include=text면 진단 프리필용 본문(진단 포트폴리오 상한까지)도 싣는다.
 * 첨부가 없으면 { info: null, chars: 0, preview: "" }.
 */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const got = await getResumePortfolioText(user.id, id);
    if (!got) return resumeNotFound();
    const text = got.text ?? "";
    const includeText = new URL(req.url).searchParams.get("include") === "text";
    return Response.json(
      {
        info: got.info,
        chars: text.length,
        preview: text.slice(0, PORTFOLIO_PREVIEW_CHARS),
        ...(includeText ? { text: text.slice(0, DIAGNOSIS_PORTFOLIO_CHARS) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/portfolio");
  }
}

/**
 * 포트폴리오 붙이기·바꾸기(이력서당 하나 — 있던 첨부는 대체되고, 보관함의 이전 포트폴리오는 그대로 남는다).
 * - application/json { portfolioId }: 내 보관함의 포트폴리오를 붙인다(남의 것·없는 것은 404). → { resume }
 * - application/json { url, title?, description? }: 링크로 보관함에 새 포트폴리오를 만들어 붙인다. → { resume, portfolio }
 * - multipart/form-data: file(+ 선택 title·description). 보관함에 새로 올리고 붙인다. 업로드 레이트 리밋(PORTFOLIO_UPLOAD_LIMIT)을 센다.
 *   → { resume, portfolio, truncated, warnings }
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

    let created: PortfolioInfo;
    let extra: { truncated?: boolean; warnings?: string[] } = {};
    if (!isMultipart(req)) {
      const input = await readJsonInput(req, ResumePortfolioAttachSchema, 16 * 1024);
      if ("portfolioId" in input) {
        const r = await attachPortfolio(user.id, id, input.portfolioId);
        if (!r.ok) return r.reason === "resume_not_found" ? resumeNotFound() : portfolioNotFound();
        return Response.json({ resume: r.resume });
      }
      created = await createPortfolioFromUrl(user.id, input);
    } else {
      const upload = await readPortfolioUpload(req, user.id);
      if (upload instanceof Response) return upload;
      const saved = await createPortfolioFromFile(user.id, upload);
      created = saved.portfolio;
      extra = { truncated: saved.truncated, warnings: saved.truncated ? [...upload.warnings, truncatedWarning()] : upload.warnings };
    }
    // 새로 만든 포트폴리오는 보관함에 남는다(이력서가 그 사이 지워졌어도).
    const r = await attachPortfolio(user.id, id, created.id);
    if (!r.ok) return r.reason === "resume_not_found" ? resumeNotFound() : portfolioNotFound();
    return Response.json({ resume: r.resume, portfolio: created, ...extra });
  } catch (err) {
    return featureErrorResponse(err, "PUT /api/resumes/[id]/portfolio");
  }
}

/** 첨부 떼기. 보관함의 포트폴리오와 저장한 글은 지우지 않는다. → { resume } */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const resume = await detachPortfolio(user.id, id);
    if (!resume) return resumeNotFound();
    return Response.json({ resume });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/resumes/[id]/portfolio");
  }
}
