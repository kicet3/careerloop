import { requireApiUser } from "@/lib/auth/session";
import { getGithubToken, withGithubReauth } from "@/lib/github/account";
import { listRepos } from "@/lib/github/api";
import { githubErrorResponse, githubNoStore, requireGithubConfigured } from "@/lib/github/http";
import { linkedProjectsByRepo } from "@/lib/github/snapshots";

export const runtime = "nodejs";
export const maxDuration = 30;

/** 내 저장소·기여한 저장소 목록(최대 200개, 비공개는 허용했을 때만). 검색·정렬은 화면에서 한다. */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cfg = requireGithubConfigured();
  if (cfg instanceof Response) return cfg;
  try {
    const { token, includePrivate, login } = await getGithubToken(user.id);
    const [repos, linked] = await Promise.all([withGithubReauth(user.id, () => listRepos(token, { includePrivate })), linkedProjectsByRepo(user.id)]);
    return Response.json(
      { login, includePrivate, repos: repos.map((r) => ({ ...r, linkedProjectId: linked.get(r.id) ?? null })) },
      { headers: githubNoStore },
    );
  } catch (err) {
    return githubErrorResponse(err, "GET /api/github/repos");
  }
}
