import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { githubErrorResponse, githubNoStore, repoDetailView, requireGithubConfigured } from "@/lib/github/http";
import { getOrFetchSnapshot } from "@/lib/github/snapshots";
import { GithubNotFoundError, isValidOwnerRepo } from "@/lib/github/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ owner: string; repo: string }> };

/** '다시 동기화': 저장소 정보를 GitHub에서 새로 읽는다(GITHUB_SYNC_LIMIT). 그래프는 바꾸지 않는다. */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cfg = requireGithubConfigured();
  if (cfg instanceof Response) return cfg;
  const { owner, repo } = await params;
  try {
    if (!isValidOwnerRepo(owner, repo)) throw new GithubNotFoundError();
    const { snapshot, fetched } = await getOrFetchSnapshot(user.id, { owner, repo }, { force: true });
    return Response.json({ ...(await repoDetailView(user.id, snapshot)), fetched }, { headers: githubNoStore });
  } catch (err) {
    return githubErrorResponse(err, "POST /api/github/repos/[owner]/[repo]/sync");
  }
}
