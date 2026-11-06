import { requireApiUser } from "@/lib/auth/session";
import { getGithubStatus } from "@/lib/github/account";
import { githubErrorResponse, githubNoStore } from "@/lib/github/http";

export const runtime = "nodejs";

/** GitHub 연결 상태. 설정이 없으면 { configured: false }(오류가 아니다). 토큰은 내려 주지 않는다. */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json(await getGithubStatus(user.id), { headers: githubNoStore });
  } catch (err) {
    return githubErrorResponse(err, "GET /api/github/status");
  }
}
