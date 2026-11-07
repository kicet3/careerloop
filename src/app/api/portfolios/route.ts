import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { CreatePortfolioFromUploadSchema, CreatePortfolioUrlSchema } from "@/lib/domain/portfolios";
import { isMultipart, readPortfolioUpload, readStagedPortfolioUpload, truncatedWarning, type PortfolioUpload } from "@/lib/portfolios/http";
import { createPortfolioFromFile, createPortfolioFromUrl, listPortfolios } from "@/lib/portfolios/service";
import { parseJsonInput, readJsonBody } from "@/lib/resumes/http";

export const runtime = "nodejs";
// PDF·HWP 추출이 길어질 수 있다(extract.ts PDF_TIME_BUDGET_MS 15초). R2에 바로 올린 큰 파일(최대 30MB)을 읽고 옮기는 시간까지.
export const maxDuration = 120;

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
 * - multipart/form-data: file(PDF·DOCX·HWP·HWPX·HTML·TXT·MD·PNG·JPG·WEBP, Vercel 4MB 이하) + 선택 title·description.
 *   원본을 그대로 보관하고(화면에 그대로 보인다) AI용 글을 뽑아 둔다. 사용자당 24시간 30회(PORTFOLIO_UPLOAD_LIMIT). → 201 { portfolio, truncated, warnings }
 * - application/json { uploadId, fileName, title?, description? }: R2에 바로 올린 큰 파일 마무리(POST /api/portfolios/uploads 참고). → 201 같은 꼴
 * - application/json: { url, title?, description? }(http/https). 서버는 그 주소를 열지 않는다. → 201 { portfolio, truncated: false, warnings: [] }
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    let upload: PortfolioUpload | Response;
    if (!isMultipart(req)) {
      const raw = await readJsonBody(req, 16 * 1024);
      if (!(raw && typeof raw === "object" && "uploadId" in raw)) {
        const input = parseJsonInput(CreatePortfolioUrlSchema, raw);
        const portfolio = await createPortfolioFromUrl(user.id, input);
        return Response.json({ portfolio, truncated: false, warnings: [] }, { status: 201 });
      }
      upload = await readStagedPortfolioUpload(user.id, parseJsonInput(CreatePortfolioFromUploadSchema, raw));
    } else {
      upload = await readPortfolioUpload(req, user.id);
    }
    if (upload instanceof Response) return upload;
    const saved = await createPortfolioFromFile(user.id, upload);
    const warnings = saved.truncated ? [...upload.warnings, truncatedWarning()] : upload.warnings;
    return Response.json({ portfolio: saved.portfolio, truncated: saved.truncated, warnings }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/portfolios");
  }
}
