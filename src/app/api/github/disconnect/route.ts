import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { disconnectGithub, getGithubStatus } from "@/lib/github/account";
import { githubErrorResponse, githubNoStore } from "@/lib/github/http";

export const runtime = "nodejs";

/**
 * GitHub 연결 해제: GitHub에서 앱 권한을 해지하고(최선 노력 — 실패해도 진행) 연결과 가져온 저장소 정보를 지운다.
 * 경험 그래프에 이미 적용한 내용은 남는다. 운영자가 GitHub 설정을 지운 뒤에도 남은 연결 기록은 지울 수 있게 설정을 요구하지 않는다.
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { revoked, deleted } = await disconnectGithub(user.id);
    return Response.json({ revoked, deleted, status: await getGithubStatus(user.id) }, { headers: githubNoStore });
  } catch (err) {
    return githubErrorResponse(err, "POST /api/github/disconnect");
  }
}
