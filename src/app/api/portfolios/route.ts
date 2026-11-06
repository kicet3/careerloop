import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { CreatePortfolioUrlSchema } from "@/lib/domain/portfolios";
import { isMultipart, readPortfolioUpload, truncatedWarning } from "@/lib/portfolios/http";
import { createPortfolioFromFile, createPortfolioFromUrl, listPortfolios } from "@/lib/portfolios/service";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// PDF·HWP 추출이 길어질 수 있다(extract.ts PDF_TIME_BUDGET_MS 15초).
export const maxDuration = 60;

/** 내 포트폴리오 보관함(최근 수정 순) + 각각을 첨부한 이력서. → { items } */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json({ items: await listPortfolios(user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/portfolios");
  }
}

/**
 * 새 포트폴리오(개수 제한 없음).
 * - multipart/form-data: file(PDF·DOCX·HWP·HWPX·HTML·TXT·MD, 4MB 이하) + 선택 title·description. 글만 뽑아 저장하고 원본은 보관하지 않는다.
 *   사용자당 24시간 30회(PORTFOLIO_UPLOAD_LIMIT). → 201 { portfolio, truncated, warnings }
 * - application/json: { url, title?, description? }(http/https). 서버는 그 주소를 열지 않는다. → 201 { portfolio, truncated: false, warnings: [] }
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    if (!isMultipart(req)) {
      const input = await readJsonInput(req, CreatePortfolioUrlSchema, 16 * 1024);
      const portfolio = await createPortfolioFromUrl(user.id, input);
      return Response.json({ portfolio, truncated: false, warnings: [] }, { status: 201 });
    }
    const upload = await readPortfolioUpload(req, user.id);
    if (upload instanceof Response) return upload;
    const saved = await createPortfolioFromFile(user.id, upload);
    const warnings = saved.truncated ? [...upload.warnings, truncatedWarning()] : upload.warnings;
    return Response.json({ portfolio: saved.portfolio, truncated: saved.truncated, warnings }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/portfolios");
  }
}
