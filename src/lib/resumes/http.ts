import "server-only";
/**
 * 이력서 라우트 공용: 크기 제한 JSON 읽기, 입력 검증 오류 문구, 404, PDF 응답.
 */
import type { z } from "zod";
import { FeatureError } from "@/lib/api/errors";
import { BodyTooLargeError, readBodyLimited } from "@/lib/diagnoses/body";
import { contentDisposition, jsonError } from "@/lib/diagnoses/http";
import { RESUME_NOT_FOUND } from "./service";

/** 이력서 본문(JSON) 한 개 + JD 여유분. */
export const MAX_RESUME_BODY_BYTES = 512 * 1024;

export const resumeNotFound = () => jsonError(RESUME_NOT_FOUND, 404);

/** 크기 제한을 지키며 JSON을 읽고 스키마로 검증한다. 실패하면 FeatureError(400·413). */
export async function readJsonInput<T>(req: Request, schema: z.ZodType<T>, maxBytes = MAX_RESUME_BODY_BYTES): Promise<T> {
  return parseJsonInput(schema, await readJsonBody(req, maxBytes));
}

/** 크기 제한을 지키며 JSON 본문만 읽는다(검증 전에 기본값을 채워야 할 때). 실패하면 FeatureError(400·413). */
export async function readJsonBody(req: Request, maxBytes = MAX_RESUME_BODY_BYTES): Promise<unknown> {
  try {
    const bytes = await readBodyLimited(req, maxBytes);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new FeatureError("요청 내용이 너무 큽니다.", 413);
    throw new FeatureError("요청 형식이 올바르지 않습니다. JSON으로 보내 주세요.", 400);
  }
}

/** 스키마 검증. 실패하면 스키마에 적은 한국어 문구(없으면 일반 문구)로 FeatureError(400). */
export function parseJsonInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // 사용자에게 보여도 되는 문구(스키마에 적은 한국어)만 그대로, 나머지는 일반 문구.
    const msg = issue && /[가-힣]/.test(issue.message) ? issue.message : "입력 내용을 확인해 주세요.";
    throw new FeatureError(msg, 400);
  }
  return parsed.data;
}

/** 파일 이름 조각: 경로·예약 문자·대괄호·제어 문자를 빼고 공백은 '_'로, 글자 수(코드 포인트) 제한. */
function fileNamePart(raw: string, max = 40): string {
  const cleaned = raw
    .normalize("NFC")
    .replace(/\[ADD:[^\]]*\]/g, "")
    .replace(/[\\/:*?"<>|[\]\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return Array.from(cleaned).slice(0, max).join("");
}

/** "<이름>_<회사>_이력서.pdf". 이름·회사가 비면 그 조각을 뺀다. Content-Disposition은 contentDisposition()이 RFC 5987로 싼다. */
export function resumePdfFileName(name: string, company: string): string {
  return [fileNamePart(name), fileNamePart(company), "이력서"].filter(Boolean).join("_") + ".pdf";
}

export function pdfResponse(pdf: Uint8Array, fileName: string): Response {
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": contentDisposition(fileName, "resume.pdf"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
