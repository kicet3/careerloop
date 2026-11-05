import { featureErrorResponse } from "@/lib/api/errors";
import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { ResumeTemplateIdSchema } from "@/lib/domain/resumes";
import { pdfResponse, resumeNotFound, resumePdfFileName } from "@/lib/resumes/http";
import { renderResumePdf } from "@/lib/resumes/pdf";
import { getVersionDocument } from "@/lib/resumes/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 이력서 PDF. ?version=<버전 id>(기본 현재 버전), ?template=<양식 id>(기본 이력서의 양식). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const url = new URL(req.url);
  const template = ResumeTemplateIdSchema.safeParse(url.searchParams.get("template"));
  try {
    const found = await getVersionDocument(user.id, id, url.searchParams.get("version"));
    if (!found) return resumeNotFound();
    const templateId = template.success ? template.data : found.resume.templateId;
    const pdf = await renderResumePdf(found.document, templateId);
    return pdfResponse(pdf, resumePdfFileName(found.document.basics.name, found.resume.company));
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/pdf");
  }
}
