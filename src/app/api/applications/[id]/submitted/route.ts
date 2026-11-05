import { featureErrorResponse } from "@/lib/api/errors";
import { getSubmittedCopy } from "@/lib/applications/service";
import { requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";

export const runtime = "nodejs";

/** 고정된 제출 사본(ResumeDocument + 양식·이름·버전 번호). 원본 이력서를 지워도 열린다. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const copy = await getSubmittedCopy(user.id, id);
    if (!copy) return jsonError("고정된 제출 사본이 없습니다.", 404);
    return Response.json(copy, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/applications/[id]/submitted");
  }
}
