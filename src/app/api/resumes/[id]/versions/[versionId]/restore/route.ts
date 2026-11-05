import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { resumeNotFound } from "@/lib/resumes/http";
import { restoreVersion } from "@/lib/resumes/service";

export const runtime = "nodejs";

/** 고른 버전 본문을 새 버전으로 복사해 현재 버전으로 삼는다. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, versionId } = await params;
  try {
    const version = await restoreVersion(user.id, id, versionId);
    if (!version) return resumeNotFound();
    return Response.json({ version }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/resumes/[id]/versions/[versionId]/restore");
  }
}
