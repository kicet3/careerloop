import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { portfolioNotFound } from "@/lib/portfolios/http";
import { regenerateShareToken } from "@/lib/portfolios/shares";

export const runtime = "nodejs";

/** 링크 다시 만들기: 새 토큰을 만들고 옛 주소는 바로 404가 된다. → { share }. 공개 중이 아니면 404. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const share = await regenerateShareToken(user.id, id.slice(0, 64));
    if (!share) return portfolioNotFound();
    return Response.json({ share }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/portfolios/[id]/share/token");
  }
}
