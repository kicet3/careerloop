import { requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { graphPortfolioErrorResponse, noStore } from "@/lib/portfolios/graph-http";
import { getGraphPortfolioJob, GRAPH_PORTFOLIO_JOB_NOT_FOUND } from "@/lib/portfolios/graph-jobs";

export const runtime = "nodejs";

/** 작업 상태(진행 화면이 폴링한다). 멈춘 작업은 이때 실패로 닫힌다. 남의 작업이면 404. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const job = await getGraphPortfolioJob(user.id, id.slice(0, 64));
    if (!job) return jsonError(GRAPH_PORTFOLIO_JOB_NOT_FOUND, 404);
    return Response.json({ job }, { headers: noStore });
  } catch (err) {
    return graphPortfolioErrorResponse(err, "GET /api/portfolios/graph/jobs/[id]");
  }
}
