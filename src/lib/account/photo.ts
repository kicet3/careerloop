import "server-only";
/**
 * 프로필 사진(설정 > 계정 > 로그인 정보). 이력서 머리글(웹 미리보기·PDF)에만 쓴다.
 *
 * - 받는 형식: JPG·PNG·WEBP, 5MB 이하(확장자가 아니라 매직 바이트로 판별). 픽셀 수 상한으로 압축 폭탄을 막는다.
 * - 서버가 sharp로 EXIF 방향을 적용한 뒤 3:4(600x800)로 가운데를 잘라 JPEG로 다시 만든다. 메타데이터(EXIF·GPS·ICC 등)는
 *   새 파일에 넣지 않는다(sharp 기본 — withMetadata를 부르지 않는다). 투명 배경은 흰색으로 채운다.
 * - 저장: users/<u>/profile/photo-<꼬리>.jpg(users.photo_key). 바꿀 때마다 새 키를 쓰고 DB가 새 키를 가리킨 뒤 옛 파일을 지운다.
 * - 읽기: 세션 사용자 자신의 사진만(GET /api/account/photo, PDF는 서버에서 data URI로 넣는다). 공개 주소는 없다.
 * - AI(LLM)에는 보내지 않는다: 사진은 ResumeDocument에 들어가지 않고, 그릴 때만 붙인다.
 */
import { randomUUID } from "node:crypto";
import { FeatureError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import { deleteObject, getObject, putObject, userKey } from "@/lib/storage";

export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PROFILE_PHOTO_WIDTH = 600;
export const PROFILE_PHOTO_HEIGHT = 800;
/** 입력 픽셀 상한(약 40MP). 넘으면 sharp가 거절한다. */
const MAX_INPUT_PIXELS = 40_000_000;

export const PROFILE_PHOTO_FORMATS_LABEL = "JPG·PNG·WEBP";

export class ProfilePhotoError extends FeatureError {}

type PhotoFormat = "jpeg" | "png" | "webp";

/** 매직 바이트로 형식 판별(모르는 형식은 null). */
export function sniffPhotoFormat(b: Uint8Array): PhotoFormat | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 12 && Buffer.from(b.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(b.subarray(8, 12)).toString("latin1") === "WEBP") {
    return "webp";
  }
  return null;
}

/**
 * 사진 정규화: 형식·크기 확인 → 방향 적용 → 3:4 가운데 잘라 600x800 → 흰 배경 → JPEG(메타데이터 없음).
 * 형식이 틀리거나 읽지 못하면 ProfilePhotoError(415·413·400).
 */
export async function processProfilePhoto(bytes: Uint8Array): Promise<Buffer> {
  if (bytes.byteLength === 0) throw new ProfilePhotoError("빈 파일입니다. 다른 사진을 골라 주세요.", 400);
  if (bytes.byteLength > PROFILE_PHOTO_MAX_BYTES) throw new ProfilePhotoError("사진은 5MB 이하만 올릴 수 있습니다.", 413);
  if (!sniffPhotoFormat(bytes)) throw new ProfilePhotoError(`${PROFILE_PHOTO_FORMATS_LABEL} 사진만 올릴 수 있습니다.`, 415);
  const sharp = (await import("sharp")).default;
  try {
    return await sharp(Buffer.from(bytes), { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false })
      .rotate()
      .resize(PROFILE_PHOTO_WIDTH, PROFILE_PHOTO_HEIGHT, { fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
  } catch {
    throw new ProfilePhotoError("사진을 읽지 못했습니다. 손상되었거나 너무 큰 사진일 수 있습니다. 다른 사진을 골라 주세요.", 400);
  }
}

function photoKey(userId: string): string {
  return userKey(userId, "profile", `photo-${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}.jpg`);
}

async function currentKey(userId: string): Promise<string | null | undefined> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { photoKey: true } });
  return row ? row.photoKey : undefined;
}

async function dropQuietly(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await deleteObject(key).catch((err) => console.error("[profile-photo] 삭제 실패", key, err));
}

/**
 * 사진 올리기·바꾸기. 처리한 JPEG를 새 키에 저장하고, DB가 '읽은 옛 키'를 그대로 가리킬 때만 새 키로 바꾼다(동시에 두 번 올리면
 * 늦은 쪽은 409 — 사진이 고아로 남지 않는다). 바꾼 뒤 옛 사진을 지운다. → 새 사진 정보.
 */
export async function setProfilePhoto(userId: string, bytes: Uint8Array): Promise<{ key: string; version: string }> {
  const jpeg = await processProfilePhoto(bytes);
  const old = await currentKey(userId);
  if (old === undefined) throw new ProfilePhotoError("계정을 찾을 수 없습니다.", 404);
  const key = photoKey(userId);
  await putObject(key, jpeg, { contentType: "image/jpeg" });
  let count: number;
  try {
    ({ count } = await prisma.user.updateMany({ where: { id: userId, photoKey: old }, data: { photoKey: key } }));
  } catch (err) {
    await dropQuietly(key);
    throw err;
  }
  if (count === 0) {
    await dropQuietly(key);
    throw new ProfilePhotoError("다른 곳에서 사진을 먼저 바꿨습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.", 409);
  }
  if (old && old !== key) await dropQuietly(old);
  return { key, version: profilePhotoVersion(key)! };
}

/** 사진 지우기. 없었으면 false. */
export async function deleteProfilePhoto(userId: string): Promise<boolean> {
  const old = await currentKey(userId);
  if (!old) return false;
  const { count } = await prisma.user.updateMany({ where: { id: userId, photoKey: old }, data: { photoKey: null } });
  if (count > 0) await dropQuietly(old);
  return count > 0;
}

/** 내 사진 JPEG(없거나 저장소에서 사라졌으면 null). 키는 세션 사용자 접두사만 읽는다. */
export async function getProfilePhoto(userId: string): Promise<Buffer | null> {
  const key = await currentKey(userId);
  if (!key || !key.startsWith(`users/${userId}/profile/`)) return null;
  return getObject(key);
}

/** PDF에 넣을 data URI(서버 안에서만 쓴다 — 공개 주소로 읽지 않는다). 없으면 null. */
export async function profilePhotoDataUri(userId: string): Promise<string | null> {
  const buf = await getProfilePhoto(userId);
  return buf ? `data:image/jpeg;base64,${buf.toString("base64")}` : null;
}

/** 키 → 화면 주소에 붙일 버전(바꾸면 img가 옛 사진을 다시 쓰지 않게). */
export function profilePhotoVersion(key: string | null | undefined): string | null {
  return key?.match(/photo-([A-Za-z0-9]+)\.jpg$/)?.[1] ?? null;
}

/** 화면에서 쓸 사진 주소(소유자만 읽는 같은 출처 라우트). 사진이 없으면 null. */
export function profilePhotoUrl(key: string | null | undefined): string | null {
  const v = profilePhotoVersion(key);
  return v ? `/api/account/photo?v=${v}` : null;
}

/** 내 사진 주소(화면용). */
export async function getProfilePhotoUrl(userId: string): Promise<string | null> {
  return profilePhotoUrl(await currentKey(userId));
}
