import "server-only";
import { createHash } from "node:crypto";
import type { Diagnosis, DiagnosisStage } from "@/lib/db/schema";
import { buildReportModel, reportAvailability } from "@/lib/report/model";
import { renderReportPdf } from "@/lib/report/pdf";
import { contentDisposition, errorResponse, jsonError, reportFileBase } from "./http";

/**
 * 렌더링한 PDF를 프로세스 메모리에 잠깐 보관한다(공개 공유 링크를 여러 번 받아도 매번 다시 그리지 않도록).
 * 키에 진단 id·완료 시각·단계 갱신 시각·공유 여부가 들어가므로 내용이 바뀌면 자연히 새 키가 된다.
 * 같은 키의 동시 요청은 렌더링 하나를 기다린다.
 */
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

type Entry = { pdf: Uint8Array; etag: string };
const globalForPdf = globalThis as unknown as {
  __pdfCache?: Map<string, Entry>;
  __pdfInflight?: Map<string, Promise<Entry>>;
};
const cache = (globalForPdf.__pdfCache ??= new Map());
const inflight = (globalForPdf.__pdfInflight ??= new Map());

function remember(key: string, entry: Entry) {
  cache.delete(key);
  cache.set(key, entry);
  let bytes = 0;
  for (const e of cache.values()) bytes += e.pdf.byteLength;
  for (const [k, e] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && bytes <= MAX_CACHE_BYTES) break;
    cache.delete(k);
    bytes -= e.pdf.byteLength;
  }
}

/** 보고서 내용이 바뀌면 달라지는 캐시 키. */
export function pdfCacheKey(found: { diagnosis: Diagnosis; stages: DiagnosisStage[] }, shared: boolean): string {
  const d = found.diagnosis;
  const stageStamp = found.stages
    .map((s) => `${s.stage}:${s.status}:${s.finishedAt?.getTime() ?? 0}`)
    .join(",");
  return createHash("sha256")
    .update([d.id, d.status, d.completedAt?.getTime() ?? 0, d.title, shared ? "s" : "o", stageStamp].join("|"))
    .digest("base64url");
}

/** 테스트용: 캐시 비우기. */
export function clearPdfCache() {
  cache.clear();
  inflight.clear();
}

/**
 * 진단 보고서 PDF 응답. 완료된 진단, 또는 실패했지만 부분 보고서를 만들 수 있는 진단(소유자만)이면 PDF, 아니면 409.
 * shared=true(공개 공유 링크)이면 완료된 진단만 허용하고, 보고서에서 진단 ID를 뺀다.
 */
export async function reportPdfResponse(
  found: { diagnosis: Diagnosis; stages: DiagnosisStage[] },
  opts: { shared?: boolean; ifNoneMatch?: string | null; extraHeaders?: Record<string, string> } = {},
): Promise<Response> {
  const shared = !!opts.shared;
  const avail = reportAvailability(found.diagnosis.status, found.stages);
  if (shared ? found.diagnosis.status !== "done" : !avail.show) {
    return jsonError("진단이 끝난 뒤에 PDF를 받을 수 있습니다.", 409);
  }
  const key = pdfCacheKey(found, shared);
  const etag = `"${key}"`;
  const baseHeaders = {
    // 공유 해제가 바로 반영되도록 공유 PDF도 중간 캐시에 남기지 않는다(ETag로 재검증만).
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    ...opts.extraHeaders,
  };
  if (opts.ifNoneMatch && opts.ifNoneMatch.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  try {
    let entry = cache.get(key);
    if (entry) {
      remember(key, entry); // 최근 사용으로 갱신
    } else {
      let pending = inflight.get(key);
      if (!pending) {
        pending = (async () => {
          const report = buildReportModel(found.diagnosis, found.stages);
          if (shared) report.meta.diagnosisId = "";
          const pdf = await renderReportPdf(report);
          const made = { pdf, etag };
          remember(key, made);
          return made;
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      entry = await pending;
    }
    const pdf = entry.pdf;
    return new Response(new Uint8Array(pdf), {
      headers: {
        ...baseHeaders,
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.byteLength),
        "Content-Disposition": contentDisposition(
          `${reportFileBase(found.diagnosis.title)}${avail.partial ? " (부분)" : ""}.pdf`,
          "resume-panel-report.pdf",
        ),
      },
    });
  } catch (err) {
    return errorResponse(err, "reportPdf");
  }
}
