import "server-only";
/**
 * 원문 캡처 라우트 공용(/api/shared-postings/[id]/capture/** 와 /api/postings/[id]/capture/**).
 * 이미지는 공개 URL 없이 이 라우트로만 보낸다(로그인·승인·동의 확인은 requireApiUser, 볼 권한은 canViewCapture).
 */
import { after } from "next/server";
import { hitDbLimit, POSTING_CAPTURE_RETRY_LIMIT, POSTING_CAPTURE_TARGET_LIMIT } from "@/lib/auth/db-rate-limit";
import type { SessionUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { getObject } from "@/lib/storage";
import { runPostingCapture } from "./capture";
import { canViewCapture, getCaptureInfo, getCaptureObject, requestCapture, sharedIdForPosting } from "./capture-store";
import { postingErrorResponse, tooManyRequests } from "./http";

export const CAPTURE_NOT_FOUND = "원문 캡처를 찾을 수 없습니다.";
const noStore = { "Cache-Control": "no-store" } as const;

type Viewer = Pick<SessionUser, "id" | "role">;

/** 라우트 대상 → 공용 공고 id(볼 수 없으면 null — 404). */
export async function resolveCaptureTarget(viewer: Viewer, target: { sharedId: string } | { postingId: string }): Promise<string | null> {
  const sharedId = "sharedId" in target ? target.sharedId.slice(0, 64) : await sharedIdForPosting(viewer.id, target.postingId.slice(0, 64));
  if (!sharedId) return null;
  return (await canViewCapture(viewer.id, sharedId, { isAdmin: viewer.role === "admin" })) ? sharedId : null;
}

/** GET 이미지 바이트. */
export async function captureImageResponse(sharedId: string | null, context: string): Promise<Response> {
  if (!sharedId) return jsonError(CAPTURE_NOT_FOUND, 404);
  try {
    const obj = await getCaptureObject(sharedId);
    const body = obj ? await getObject(obj.key) : null;
    if (!obj || !body) return jsonError(CAPTURE_NOT_FOUND, 404);
    const ext = obj.mime === "image/webp" ? "webp" : "jpg";
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": obj.mime,
        "Content-Length": String(body.length),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="posting-capture.${ext}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ...(obj.capturedAt ? { "Last-Modified": new Date(obj.capturedAt).toUTCString() } : {}),
      },
    });
  } catch (err) {
    return postingErrorResponse(err, context);
  }
}

/** GET 캡처 정보. */
export async function captureInfoResponse(sharedId: string | null, context: string): Promise<Response> {
  if (!sharedId) return jsonError(CAPTURE_NOT_FOUND, 404);
  try {
    const capture = await getCaptureInfo(sharedId);
    if (!capture) return jsonError(CAPTURE_NOT_FOUND, 404);
    return Response.json(capture, { headers: noStore });
  } catch (err) {
    return postingErrorResponse(err, context);
  }
}

/**
 * POST 다시 시도: 이미 찍는 중이거나 저장돼 있으면 지금 상태를 돌려준다(횟수를 쓰지 않는다). 시도 상한을 넘었으면 409.
 * 그 밖에는 사용자(24시간 10회)·공고(1시간 3회) 제한을 센 뒤 예약하고 after()로 찍는다 → 202 { capture }.
 */
export async function captureRetryResponse(viewer: Viewer, sharedId: string | null, context: string): Promise<Response> {
  if (!sharedId) return jsonError(CAPTURE_NOT_FOUND, 404);
  try {
    const current = await getCaptureInfo(sharedId);
    if (!current) return jsonError(CAPTURE_NOT_FOUND, 404);
    if (current.status === "pending" || current.status === "running" || current.status === "done") {
      return Response.json({ capture: current }, { status: current.status === "done" ? 200 : 202, headers: noStore });
    }
    if (!current.retryable) return jsonError("여러 번 캡처하지 못한 페이지입니다. 원문 링크로 확인해 주세요.", 409);
    const mine = await hitDbLimit(POSTING_CAPTURE_RETRY_LIMIT, viewer.id);
    if (!mine.ok) return tooManyRequests("캡처 다시 시도는 하루 10번까지 할 수 있습니다. 나중에 다시 시도해 주세요.", mine.retryAfterSec);
    const target = await hitDbLimit(POSTING_CAPTURE_TARGET_LIMIT, sharedId);
    if (!target.ok) return tooManyRequests("이 공고는 방금 여러 번 캡처를 시도했습니다. 잠시 후 다시 시도해 주세요.", target.retryAfterSec);
    if (await requestCapture(sharedId)) {
      after(() => runPostingCapture(sharedId));
    }
    return Response.json({ capture: await getCaptureInfo(sharedId) }, { status: 202, headers: noStore });
  } catch (err) {
    return postingErrorResponse(err, context);
  }
}
