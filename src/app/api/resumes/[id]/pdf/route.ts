import { profilePhotoDataUri } from "@/lib/account/photo";
import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { ResumeTemplateIdSchema } from "@/lib/domain/resumes";
import { pdfResponse, resumeNotFound, resumePdfFileName } from "@/lib/resumes/http";
import { renderResumePdf } from "@/lib/resumes/pdf";
import { getVersionDocument } from "@/lib/resumes/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 이력서 PDF. ?version=<버전 id>(기본 현재 버전), ?template=<양식 id>(기본 이력서의 양식).
 * 이력서의 '사진 넣기'가 켜져 있고 프로필 사진이 있으면 머리글에 넣는다(세션 사용자 자신의 사진을 서버에서 읽어 data URI로 — 공개 주소 없음).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const url = new URL(req.url);
  const template = ResumeTemplateIdSchema.safeParse(url.searchParams.get("template"));
  try {
    const found = await getVersionDocument(user.id, id, url.searchParams.get("version"));
    if (!found) return resumeNotFound();
    const templateId = template.success ? template.data : found.resume.templateId;
    const photo = found.resume.includePhoto ? await profilePhotoDataUri(user.id) : null;
    const pdf = await renderResumePdf(found.document, templateId, { photo });
    return pdfResponse(pdf, resumePdfFileName(found.document.basics.name, found.resume.company));
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/pdf");
  }
}
