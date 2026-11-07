import { profilePhotoDataUri } from "@/lib/account/photo";
import { featureErrorResponse } from "@/lib/api/errors";
import { getApplication, getSubmittedCopy } from "@/lib/applications/service";
import { requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { ResumeTemplateIdSchema } from "@/lib/domain/resumes";
import { pdfResponse, resumePdfFileName } from "@/lib/resumes/http";
import { renderResumePdf } from "@/lib/resumes/pdf";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 제출 사본 PDF. ?template=<양식 id>(기본은 사본을 만들 때의 양식).
 * 사본을 만들 때 '사진 넣기'가 켜져 있었으면 세션 사용자 자신의 지금 프로필 사진을 넣는다(이력서 PDF와 같은 머리글).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const template = ResumeTemplateIdSchema.safeParse(new URL(req.url).searchParams.get("template"));
  try {
    const [copy, application] = await Promise.all([getSubmittedCopy(user.id, id), getApplication(user.id, id)]);
    if (!copy || !application) return jsonError("고정된 제출 사본이 없습니다.", 404);
    const photo = copy.includePhoto ? await profilePhotoDataUri(user.id) : null;
    const pdf = await renderResumePdf(copy.document, template.success ? template.data : copy.templateId, { photo });
    return pdfResponse(pdf, resumePdfFileName(copy.document.basics.name, application.company));
  } catch (err) {
    return featureErrorResponse(err, "GET /api/applications/[id]/submitted/pdf");
  }
}
