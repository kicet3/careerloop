/**
 * 진단 라우트 핸들러 공용 응답 도우미.
 */
import { IngestError } from "@/lib/ingest/extract";
import { DiagnosisServiceError } from "./errors";

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export const notFound = () => jsonError("진단을 찾을 수 없습니다.", 404);

/** 서비스·수집 오류는 메시지 그대로, 나머지는 로그 후 500. */
export function errorResponse(err: unknown, context: string): Response {
  if (err instanceof DiagnosisServiceError || err instanceof IngestError) {
    return jsonError(err.message, err.status);
  }
  console.error(`[${context}]`, err);
  return jsonError("서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.", 500);
}

/** RFC 5987/6266: ASCII 대체 이름 + UTF-8 원래 이름. */
export function contentDisposition(fileName: string, fallback: string): string {
  const safe = fileName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || fallback;
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function reportFileBase(title: string): string {
  return `이력서 심사 보고서 - ${title}`.slice(0, 150);
}
