import { z } from "zod";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson } from "@/lib/chat/graph-chat";
import { jsonError } from "@/lib/diagnoses/http";
import { getGithubStatus, setGithubIncludePrivate } from "@/lib/github/account";
import { githubErrorResponse, githubJsonError, githubNoStore, requireGithubConfigured } from "@/lib/github/http";
import { GithubAuthError } from "@/lib/github/types";

export const runtime = "nodejs";

const BodySchema = z.object({ includePrivate: z.boolean() });

/** 비공개 저장소도 가져올지(기본 꺼짐). 연결이 없으면 409. */
export async function PATCH(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const cfg = requireGithubConfigured();
  if (cfg instanceof Response) return cfg;
  try {
    const body = BodySchema.safeParse(await readSmallJson(req));
    if (!body.success) return jsonError("요청 형식이 올바르지 않습니다.", 400);
    if (!(await setGithubIncludePrivate(user.id, body.data.includePrivate))) {
      return githubJsonError(new GithubAuthError("GitHub 계정을 먼저 연결해 주세요.", "github_not_connected"));
    }
    return Response.json(await getGithubStatus(user.id), { headers: githubNoStore });
  } catch (err) {
    return githubErrorResponse(err, "PATCH /api/github/settings");
  }
}
