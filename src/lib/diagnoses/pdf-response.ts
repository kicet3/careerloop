import "server-only";
import type { Diagnosis, DiagnosisStage } from "@/lib/db/schema";
import { buildReportModel } from "@/lib/report/model";
import { renderReportPdf } from "@/lib/report/pdf";
import { contentDisposition, errorResponse, jsonError, reportFileBase } from "./http";

/** 완료된 진단의 보고서 PDF 응답. 미완료면 409. */
export async function reportPdfResponse(
  found: { diagnosis: Diagnosis; stages: DiagnosisStage[] },
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (found.diagnosis.status !== "done") {
    return jsonError("진단이 끝난 뒤에 PDF를 받을 수 있습니다.", 409);
  }
  try {
    const report = buildReportModel(found.diagnosis, found.stages);
    const pdf = await renderReportPdf(report);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.byteLength),
        "Content-Disposition": contentDisposition(`${reportFileBase(found.diagnosis.title)}.pdf`, "resume-panel-report.pdf"),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...extraHeaders,
      },
    });
  } catch (err) {
    return errorResponse(err, "reportPdf");
  }
}
