import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { MAX_PORTFOLIO_TEXT_CHARS, ReplacePortfolioTextSchema } from "@/lib/domain/portfolios";
import { portfolioNotFound } from "@/lib/portfolios/http";
import { saveGraphPortfolioText } from "@/lib/portfolios/graph-jobs";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

/** 본문 상한(UTF-8 최대 4바이트/글자) + JSON 여유. */
const MAX_BODY_BYTES = MAX_PORTFOLIO_TEXT_CHARS * 4 + 4096;

/** 본문 고치기(경험 그래프로 만든 포트폴리오). { text } → { portfolio }. 남의 것이면 404, 파일·링크·다시 만드는 중·동시 저장이면 409. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const { text } = await readJsonInput(req, ReplacePortfolioTextSchema, MAX_BODY_BYTES);
    const saved = await saveGraphPortfolioText(user.id, id.slice(0, 64), text);
    if (saved === null) return portfolioNotFound();
    if (saved === "not_graph") return jsonError("경험 그래프로 만든 포트폴리오만 본문을 고칠 수 있습니다. 파일은 '내용 바꾸기'로 다시 올려 주세요.", 409);
    return Response.json({ portfolio: saved.portfolio });
  } catch (err) {
    return featureErrorResponse(err, "PUT /api/portfolios/[id]/text");
  }
}
