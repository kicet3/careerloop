import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { resumeNotFound } from "@/lib/resumes/http";
import { getVersionDocument } from "@/lib/resumes/service";

export const runtime = "nodejs";

/** 특정 버전 본문(버전 목록에서 미리보기·비교용). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, versionId } = await params;
  try {
    const found = await getVersionDocument(user.id, id, versionId);
    if (!found) return resumeNotFound();
    return Response.json({ version: found.version, document: found.document }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/versions/[versionId]");
  }
}
