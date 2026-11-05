import { featureErrorResponse } from "@/lib/api/errors";
import { applicationNotFound, limitWrite, MAX_APPLICATION_BODY_BYTES } from "@/lib/applications/http";
import { deleteApplication, getApplication, updateApplication } from "@/lib/applications/service";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { ApplicationUpdateInputSchema } from "@/lib/domain/applications";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 지원 하나 + 단계 이력. */
export async function GET(_req: Request, { params }: Ctx) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const application = await getApplication(user.id, id);
    if (!application) return applicationNotFound();
    return Response.json({ application }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/applications/[id]");
  }
}

/** 지원 수정(단계 제외 — 단계는 POST /api/applications/[id]/stage). */
export async function PATCH(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limited = limitWrite(user.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    const patch = await readJsonInput(req, ApplicationUpdateInputSchema, MAX_APPLICATION_BODY_BYTES);
    const application = await updateApplication(user.id, id, patch);
    if (!application) return applicationNotFound();
    return Response.json({ application });
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/applications/[id]");
  }
}

/** 지원 삭제(단계 이력·제출 사본 포함). 연결된 공고에 다른 지원이 없으면 공고를 '지원 예정'으로 되돌린다. */
export async function DELETE(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limited = limitWrite(user.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    if (!(await deleteApplication(user.id, id))) return applicationNotFound();
    return new Response(null, { status: 204 });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/applications/[id]");
  }
}
