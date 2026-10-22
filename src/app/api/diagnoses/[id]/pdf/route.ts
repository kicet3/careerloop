import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { errorResponse, notFound } from "@/lib/diagnoses/http";
import { reportPdfResponse } from "@/lib/diagnoses/pdf-response";
import { getDiagnosisForUser } from "@/lib/diagnoses/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    const found = await getDiagnosisForUser(id, user.id);
    if (!found) return notFound();
    return await reportPdfResponse(found);
  } catch (err) {
    return errorResponse(err, "GET /api/diagnoses/[id]/pdf");
  }
}
