import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { listVersions, saveVersion } from "@/lib/resumes/service";
import { SaveResumeVersionSchema } from "@/lib/resumes/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const versions = await listVersions(user.id, id);
    if (!versions) return resumeNotFound();
    return Response.json({ versions }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/versions");
  }
}

/** 저장 = 새 버전. baseVersionId가 현재 버전과 다르면 409. */
export async function POST(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const input = await readJsonInput(req, SaveResumeVersionSchema);
    const version = await saveVersion(user.id, id, input.document, {
      source: "manual",
      note: input.note,
      baseVersionId: input.baseVersionId,
    });
    if (!version) return resumeNotFound();
    return Response.json({ version }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/resumes/[id]/versions");
  }
}
