import { featureErrorResponse } from "@/lib/api/errors";
import { limitWrite, MAX_APPLICATION_BODY_BYTES } from "@/lib/applications/http";
import { createApplication, listApplications } from "@/lib/applications/service";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ApplicationCreateInputSchema } from "@/lib/domain/applications";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

/** 지원 목록(최근 수정순). ?postingId=<공고 id>면 그 공고의 지원만. */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const postingId = new URL(req.url).searchParams.get("postingId")?.trim() || null;
  try {
    const items = await listApplications(user.id, { postingId });
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/applications");
  }
}

/** 지원 기록 추가. 공고를 고르면 회사·직무를 채우고 공고를 '지원함'으로 바꾼다. */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limited = limitWrite(user.id);
  if (limited) return limited;
  try {
    const input = await readJsonInput(req, ApplicationCreateInputSchema, MAX_APPLICATION_BODY_BYTES);
    const application = await createApplication(user.id, input);
    return Response.json({ application }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/applications");
  }
}
