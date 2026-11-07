import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { StartGraphPortfolioSchema } from "@/lib/domain/graph-portfolio";
import { graphProjectOptions, loadOwnGraph } from "@/lib/portfolios/graph-material";
import { assertGraphPortfolioLimit, graphPortfolioErrorResponse, noStore, scheduleGraphPortfolioJob } from "@/lib/portfolios/graph-http";
import { startGraphPortfolioJob } from "@/lib/portfolios/graph-jobs";
import { graphEnabled } from "@/lib/graph/service";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// after()로 이어지는 포트폴리오 작성(LLM 1회)의 시간 상한(graph-jobs.ts GRAPH_PORTFOLIO_ROUTE_MAX_DURATION_SEC와 같다). Next가 정적으로 읽으므로 리터럴.
export const maxDuration = 300;

/** 만들기 화면의 프로젝트 고르기 목록(내 경험 그래프의 Project 노드). → { enabled, projects } */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  if (!graphEnabled()) return Response.json({ enabled: false, projects: [] }, { headers: noStore });
  try {
    const graph = await loadOwnGraph(user);
    return Response.json({ enabled: true, projects: graphProjectOptions(graph) }, { headers: noStore });
  } catch (err) {
    return graphPortfolioErrorResponse(err, "GET /api/portfolios/graph");
  }
}

/**
 * 경험 그래프로 포트폴리오 만들기(portfolioId가 있으면 그 포트폴리오를 다시 만들기). 작업 행만 만들고 202 { job } —
 * 본문은 응답 뒤 백그라운드에서 쓴다(화면은 /app/portfolios/drafts/[id]에서 폴링). 고른 프로젝트가 내 그래프에 없으면 400.
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const input = await readJsonInput(req, StartGraphPortfolioSchema, 16 * 1024);
    const { job, runId, provider } = await startGraphPortfolioJob(user, input, { beforeCreate: () => assertGraphPortfolioLimit(user.id) });
    scheduleGraphPortfolioJob(user.id, job.id, runId, provider);
    return Response.json({ job }, { status: 202, headers: noStore });
  } catch (err) {
    return graphPortfolioErrorResponse(err, "POST /api/portfolios/graph");
  }
}
