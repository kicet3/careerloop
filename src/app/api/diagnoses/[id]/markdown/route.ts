import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { contentDisposition, errorResponse, jsonError, notFound } from "@/lib/diagnoses/http";
import { getDiagnosisForUser } from "@/lib/diagnoses/service";
import { renderPanelMarkdown, renderResumeMarkdown } from "@/lib/report/markdown";
import { buildReportModel } from "@/lib/report/model";

export const runtime = "nodejs";

/** 원본 스킬 호환 내보내기: ?file=panel → PANEL.md, ?file=resume → RESUME-IMPROVED.md */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const file = new URL(req.url).searchParams.get("file") ?? "panel";
  if (file !== "panel" && file !== "resume") {
    return jsonError("file은 panel 또는 resume이어야 합니다.", 400);
  }

  try {
    const found = await getDiagnosisForUser(id, user.id);
    if (!found) return notFound();
    if (found.diagnosis.status !== "done") {
      return jsonError("진단이 끝난 뒤에 내려받을 수 있습니다.", 409);
    }
    const report = buildReportModel(found.diagnosis, found.stages);
    if (file === "resume" && !report.rewrite) {
      return jsonError("개선된 이력서가 없습니다.", 404);
    }
    const body = file === "panel" ? renderPanelMarkdown(report) : renderResumeMarkdown(report);
    const name = file === "panel" ? "PANEL.md" : "RESUME-IMPROVED.md";
    return new Response(body, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": contentDisposition(name, name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/diagnoses/[id]/markdown");
  }
}
