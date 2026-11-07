import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { assertGraphPortfolioLimit, graphPortfolioErrorResponse, noStore, scheduleGraphPortfolioJob } from "@/lib/portfolios/graph-http";
import { GRAPH_PORTFOLIO_JOB_NOT_FOUND, restartGraphPortfolioJob } from "@/lib/portfolios/graph-jobs";

export const runtime = "nodejs";
// after()로 이어지는 실행의 시간 상한(POST /api/portfolios/graph와 같다).
export const maxDuration = 300;

/** 실패했거나 멈춘 작업을 같은 입력으로 다시 실행한다(202). 진행 중이거나 완성됐으면 409, 남의 작업이면 404. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const started = await restartGraphPortfolioJob(user.id, id.slice(0, 64), { beforeRestart: () => assertGraphPortfolioLimit(user.id) });
    if (!started) return jsonError(GRAPH_PORTFOLIO_JOB_NOT_FOUND, 404);
    scheduleGraphPortfolioJob(user.id, started.job.id, started.runId, started.provider);
    return Response.json({ job: started.job }, { status: 202, headers: noStore });
  } catch (err) {
    return graphPortfolioErrorResponse(err, "POST /api/portfolios/graph/jobs/[id]/retry");
  }
}
