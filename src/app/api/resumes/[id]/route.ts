import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { deleteResume, getResumeDetail, updateResumeMeta } from "@/lib/resumes/service";
import { UpdateResumeMetaSchema } from "@/lib/resumes/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 메타 + 버전 목록 + 현재 본문. */
export async function GET(_req: Request, { params }: Ctx) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const detail = await getResumeDetail(user.id, id);
    if (!detail) return resumeNotFound();
    return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]");
  }
}

/** 메타 수정(회사·직무·JD·제목·양식). 본문은 버전 저장으로. */
export async function PATCH(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const patch = await readJsonInput(req, UpdateResumeMetaSchema);
    const resume = await updateResumeMeta(user.id, id, patch);
    if (!resume) return resumeNotFound();
    return Response.json({ resume });
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/resumes/[id]");
  }
}

/** 이력서와 모든 버전(저장소 객체 포함) 삭제. */
export async function DELETE(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    if (!(await deleteResume(user.id, id))) return resumeNotFound();
    return new Response(null, { status: 204 });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/resumes/[id]");
  }
}
