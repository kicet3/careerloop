import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { listVersions, saveVersion } from "@/lib/resumes/service";
import { SaveResumeVersionSchema } from "@/lib/resumes/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
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

/** 저장 = 새 버전. baseVersionId가 현재 버전과 다르면 409. templateId를 주면 이력서 양식도 함께 바꾼다. 저장되면 임시 저장본을 지운다. */
export async function POST(req: Request, { params }: Ctx) {
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
      templateId: input.templateId,
      // 편집 화면의 '저장(새 버전)': 임시 저장본은 이 버전에 담겼으므로 지운다.
      clearEditDraft: true,
    });
    if (!version) return resumeNotFound();
    return Response.json({ version }, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/resumes/[id]/versions");
  }
}
