import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { matchPosting } from "@/lib/graph/match-service";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 공고 요구 기술 ↔ 내 경력 그래프 대조. 남의 공고는 404, 그래프 저장소가 꺼져 있으면 503. */
export async function GET(_req: Request, { params }: Ctx) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    const body = await matchPosting(user.id, id);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/postings/[id]/match");
  }
}
