import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { errorResponse, notFound } from "@/lib/diagnoses/http";
import { deleteDiagnosis, getDiagnosisForUser, markStaleRunsFailed } from "@/lib/diagnoses/service";
import type { DiagnosisStatusResponse } from "@/lib/diagnoses/types";
import { buildReportModel } from "@/lib/report/model";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    await markStaleRunsFailed(user.id);
    const found = await getDiagnosisForUser(id, user.id);
    if (!found) return notFound();
    const { diagnosis: d, stages } = found;

    const body: DiagnosisStatusResponse = {
      id: d.id,
      status: d.status,
      error: d.error,
      title: d.title,
      shareToken: d.shareToken,
      stages: stages.map((s) => ({ stage: s.stage, status: s.status, error: s.error })),
      report: d.status === "done" ? buildReportModel(d, stages) : null,
    };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/diagnoses/[id]");
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    const deleted = await deleteDiagnosis(id, user.id);
    return deleted ? new Response(null, { status: 204 }) : notFound();
  } catch (err) {
    return errorResponse(err, "DELETE /api/diagnoses/[id]");
  }
}
