import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { githubErrorResponse, githubNoStore, repoDetailView, requireGithubConfigured } from "@/lib/github/http";
import { getOrFetchSnapshot } from "@/lib/github/snapshots";
import { GithubNotFoundError, isValidOwnerRepo } from "@/lib/github/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ owner: string; repo: string }> };

/**
 * 저장소 정보(24시간 안에 읽은 것은 다시 쓴다)와 경험 그래프 프로젝트 후보. 새로 읽을 때만 GITHUB_SYNC_LIMIT을 센다.
 * 스냅샷을 쓰고 한도를 쓰는 GET이라 다른 사이트에서 연 요청(Sec-Fetch-Site: cross-site, 다른 Origin)은 막는다.
 */
export async function GET(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cfg = requireGithubConfigured();
  if (cfg instanceof Response) return cfg;
  const { owner, repo } = await params;
  try {
    if (!isValidOwnerRepo(owner, repo)) throw new GithubNotFoundError();
    const { snapshot, fetched } = await getOrFetchSnapshot(user.id, { owner, repo });
    return Response.json({ ...(await repoDetailView(user.id, snapshot)), fetched }, { headers: githubNoStore });
  } catch (err) {
    return githubErrorResponse(err, "GET /api/github/repos/[owner]/[repo]");
  }
}
