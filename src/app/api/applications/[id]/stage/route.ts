import { featureErrorResponse } from "@/lib/api/errors";
import { applicationNotFound, limitWrite, MAX_APPLICATION_BODY_BYTES } from "@/lib/applications/http";
import { changeStage } from "@/lib/applications/service";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { ApplicationStageInputSchema } from "@/lib/domain/applications";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

/** 단계 변경 + 이력 한 줄. 지원서를 낸 단계로 처음 들어가면 제출 사본을 고정한다. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limited = limitWrite(user.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    const input = await readJsonInput(req, ApplicationStageInputSchema, MAX_APPLICATION_BODY_BYTES);
    const application = await changeStage(user.id, id, input);
    if (!application) return applicationNotFound();
    return Response.json({ application });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/applications/[id]/stage");
  }
}
