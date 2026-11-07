import { requireApiUser } from "@/lib/auth/session";
import { graphPortfolioErrorResponse, noStore } from "@/lib/portfolios/graph-http";
import { listVisibleGraphPortfolioJobs } from "@/lib/portfolios/graph-jobs";

export const runtime = "nodejs";

/** 보관함에 보일 포트폴리오 작업(진행 중 + 최근 하루 안에 실패한 것). */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json({ items: await listVisibleGraphPortfolioJobs(user.id) }, { headers: noStore });
  } catch (err) {
    return graphPortfolioErrorResponse(err, "GET /api/portfolios/graph/jobs");
  }
}
