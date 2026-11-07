import { featureErrorResponse } from "@/lib/api/errors";
import { deleteProfilePhoto, getProfilePhoto, PROFILE_PHOTO_FORMATS_LABEL, PROFILE_PHOTO_MAX_BYTES, profilePhotoUrl, setProfilePhoto } from "@/lib/account/photo";
import { hitDbLimit, PROFILE_PHOTO_LIMIT } from "@/lib/auth/db-rate-limit";
import { assertSameOrigin, requireSignedInApiUser } from "@/lib/auth/session";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { jsonError } from "@/lib/diagnoses/http";

export const runtime = "nodejs";

/** 내 프로필 사진(JPEG). 세션 사용자 자신의 사진만 — 다른 사용자의 사진을 고르는 인자는 없다. 없으면 404. */
export async function GET() {
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  try {
    const photo = await getProfilePhoto(user.id);
    if (!photo) return jsonError("프로필 사진이 없습니다.", 404);
    return new Response(new Uint8Array(photo), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(photo.byteLength),
        "Content-Disposition": 'inline; filename="profile.jpg"',
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
      },
    });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/account/photo");
  }
}

/**
 * 사진 올리기·바꾸기. multipart/form-data의 photo(JPG·PNG·WEBP, 5MB 이하). 서버가 3:4(600x800) JPEG로 다시 만들고 EXIF를 지운다.
 * 사용자당 24시간 PROFILE_PHOTO_LIMIT회. → 200 { photoUrl }
 */
export async function PUT(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  try {
    const limit = await hitDbLimit(PROFILE_PHOTO_LIMIT, user.id);
    if (!limit.ok) {
      return Response.json(
        { error: "오늘 사진을 너무 많이 바꿨습니다. 내일 다시 시도해 주세요." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
      );
    }
    let form: FormData;
    try {
      form = await readFormDataLimited(req, PROFILE_PHOTO_MAX_BYTES + 64 * 1024);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return jsonError("사진은 5MB 이하만 올릴 수 있습니다.", 413);
      return jsonError("요청 형식이 올바르지 않습니다. multipart/form-data로 보내 주세요.", 400);
    }
    const f = form.get("photo");
    if (!f || typeof f !== "object" || !("arrayBuffer" in f) || f.size === 0) {
      return jsonError(`올릴 사진(${PROFILE_PHOTO_FORMATS_LABEL})을 골라 주세요.`, 400);
    }
    const saved = await setProfilePhoto(user.id, new Uint8Array(await (f as File).arrayBuffer()));
    return Response.json({ photoUrl: profilePhotoUrl(saved.key) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "PUT /api/account/photo");
  }
}

/** 사진 지우기(이력서 머리글에서도 빠진다). → { ok: true, deleted } */
export async function DELETE(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  try {
    const deleted = await deleteProfilePhoto(user.id);
    return Response.json({ ok: true, deleted }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/account/photo");
  }
}
