import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { MAX_PORTFOLIO_CHARS as DIAGNOSIS_PORTFOLIO_CHARS } from "@/lib/diagnoses/form";
import { ReplacePortfolioUrlSchema, UpdatePortfolioSchema } from "@/lib/domain/portfolios";
import { isMultipart, PORTFOLIO_PREVIEW_CHARS, portfolioNotFound, readPortfolioUpload, truncatedWarning } from "@/lib/portfolios/http";
import { deletePortfolio, getPortfolio, getPortfolioText, replacePortfolioFile, replacePortfolioUrl, updatePortfolio } from "@/lib/portfolios/service";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// PDF·HWP 추출이 길어질 수 있다(extract.ts PDF_TIME_BUDGET_MS 15초).
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/**
 * 포트폴리오 + 첨부한 이력서 + 글자 수 + 앞부분 미리보기. ?include=text면 진단에 넣을 본문(진단 포트폴리오 상한까지)도 싣는다.
 * → { portfolio, chars, preview, text? }
 */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const [portfolio, got] = await Promise.all([getPortfolio(user.id, id), getPortfolioText(user.id, id)]);
    if (!portfolio || !got) return portfolioNotFound();
    const text = got.text ?? "";
    const includeText = new URL(req.url).searchParams.get("include") === "text";
    return Response.json(
      {
        portfolio,
        chars: text.length,
        preview: text.slice(0, PORTFOLIO_PREVIEW_CHARS),
        ...(includeText ? { text: text.slice(0, DIAGNOSIS_PORTFOLIO_CHARS) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return featureErrorResponse(err, "GET /api/portfolios/[id]");
  }
}

/** 이름·설명 고치기. { title?, description? } → { portfolio } */
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const patch = await readJsonInput(req, UpdatePortfolioSchema, 16 * 1024);
    const portfolio = await updatePortfolio(user.id, id, patch);
    if (!portfolio) return portfolioNotFound();
    return Response.json({ portfolio });
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/portfolios/[id]");
  }
}

/**
 * 내용 바꾸기(이름·설명·첨부한 이력서는 그대로).
 * - multipart/form-data: file. 업로드 레이트 리밋을 센다. → { portfolio, truncated, warnings }
 * - application/json: { url }. → { portfolio, truncated: false, warnings: [] }
 */
export async function PUT(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    // 본문을 읽기 전에 내 포트폴리오인지 먼저 본다.
    if (!(await getPortfolio(user.id, id))) return portfolioNotFound();
    if (!isMultipart(req)) {
      const { url } = await readJsonInput(req, ReplacePortfolioUrlSchema, 8 * 1024);
      const portfolio = await replacePortfolioUrl(user.id, id, url);
      if (!portfolio) return portfolioNotFound();
      return Response.json({ portfolio, truncated: false, warnings: [] });
    }
    const upload = await readPortfolioUpload(req, user.id);
    if (upload instanceof Response) return upload;
    const saved = await replacePortfolioFile(user.id, id, upload);
    if (!saved) return portfolioNotFound();
    const warnings = saved.truncated ? [...upload.warnings, truncatedWarning()] : upload.warnings;
    return Response.json({ portfolio: saved.portfolio, truncated: saved.truncated, warnings });
  } catch (err) {
    return featureErrorResponse(err, "PUT /api/portfolios/[id]");
  }
}

/** 지우기(저장한 글도 지운다). 첨부한 이력서에서는 떨어진다. → { ok: true, detached } */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const done = await deletePortfolio(user.id, id);
    if (!done) return portfolioNotFound();
    return Response.json({ ok: true, detached: done.detached });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/portfolios/[id]");
  }
}
