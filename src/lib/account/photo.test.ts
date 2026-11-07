/** 프로필 사진 처리(sharp): 3:4 600x800 JPEG로 다시 만들고 EXIF·GPS를 지운다, 방향 적용, 형식·크기 거절. 저장·바꾸기·지우기(PGlite + 로컬 저장소). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let photo: typeof import("./photo");
let storage: typeof import("@/lib/storage");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-photo-")), "storage");
  tdb = await createTestDb();
  photo = await import("./photo");
  storage = await import("@/lib/storage");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

/** 가로 1200x600 JPEG + EXIF(GPS 대신 IFD0 문자열·방향 6 = 90도 회전). */
async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 600, channels: 3, background: "#cc3344" } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "secret-location", Artist: "me" } } })
    .toBuffer();
}

describe("processProfilePhoto", () => {
  it("600x800 JPEG, 메타데이터(EXIF) 없음", async () => {
    const src = await jpegWithExif();
    expect((await sharp(src).metadata()).exif).toBeDefined();
    const out = await photo.processProfilePhoto(src);
    const meta = await sharp(out).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 600, height: 800 });
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(out.includes(Buffer.from("secret-location"))).toBe(false);
  });

  it("PNG·WEBP(투명 포함)도 받는다", async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const webp = await sharp({ create: { width: 90, height: 120, channels: 3, background: "#00ff00" } }).webp().toBuffer();
    for (const b of [png, webp]) expect(await sharp(await photo.processProfilePhoto(b)).metadata()).toMatchObject({ format: "jpeg", width: 600, height: 800 });
  });

  it("GIF·SVG·글은 415, 5MB 초과 413, 빈 파일·깨진 JPEG는 400", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).gif().toBuffer();
    await expect(photo.processProfilePhoto(gif)).rejects.toMatchObject({ status: 415 });
    await expect(photo.processProfilePhoto(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).rejects.toMatchObject({ status: 415 });
    await expect(photo.processProfilePhoto(new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
    await expect(photo.processProfilePhoto(new Uint8Array())).rejects.toMatchObject({ status: 400 });
    await expect(photo.processProfilePhoto(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))).rejects.toMatchObject({ status: 400 });
  });
});

describe("저장·바꾸기·지우기", () => {
  it("users/<u>/profile/에 저장하고, 바꾸면 옛 사진을 지우며, 다른 사용자와 섞이지 않는다", async () => {
    const first = await photo.setProfilePhoto("ua", await jpegWithExif());
    expect(first.key).toMatch(/^users\/ua\/profile\/photo-[A-Za-z0-9]+\.jpg$/);
    expect(photo.profilePhotoUrl(first.key)).toBe(`/api/account/photo?v=${first.version}`);
    expect(await photo.getProfilePhoto("ub")).toBeNull();
    expect(await photo.profilePhotoDataUri("ua")).toMatch(/^data:image\/jpeg;base64,\/9j\//);

    const second = await photo.setProfilePhoto("ua", await jpegWithExif());
    expect(second.key).not.toBe(first.key);
    expect(await storage.getObject(first.key)).toBeNull();
    expect(await storage.listByPrefix(storage.userPrefix("ua", "profile"))).toEqual([second.key]);

    expect(await photo.deleteProfilePhoto("ua")).toBe(true);
    expect(await photo.deleteProfilePhoto("ua")).toBe(false);
    expect(await storage.listByPrefix(storage.userPrefix("ua", "profile"))).toEqual([]);
    expect(await photo.getProfilePhotoUrl("ua")).toBeNull();
  });

  it("행이 남의 키를 가리키도록 조작돼 있어도 읽지 않는다", async () => {
    const b = await photo.setProfilePhoto("ub", await jpegWithExif());
    await tdb.prisma.user.update({ where: { id: "ua" }, data: { photoKey: b.key } });
    expect(await photo.getProfilePhoto("ua")).toBeNull();
    expect(await photo.profilePhotoDataUri("ua")).toBeNull();
  });
});
