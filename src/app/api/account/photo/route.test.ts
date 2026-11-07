/**
 * /api/account/photo(PGlite + 로컬 저장소, 실제 세션 쿠키): 올리기·바꾸기·지우기, 자기 사진만 읽기(헤더),
 * 로그인·같은 출처 확인, 형식·크기 거절, 레이트 리밋.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {} }));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

let tdb: TestDb;
let route: typeof import("./route");
let limits: typeof import("@/lib/auth/db-rate-limit");
let docs: typeof import("@/lib/legal/consents");

const ORIGIN = "http://localhost:3000";
const URL_ = `${ORIGIN}/api/account/photo`;

async function seed(id: string) {
  await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  const token = `tok-${id}`;
  await tdb.prisma.session.create({
    data: { id: createHash("sha256").update(token).digest("hex"), userId: id, expiresAt: new Date(Date.now() + 20 * 86_400_000) },
  });
  await tdb.prisma.userConsent.createMany({
    data: docs.REQUIRED_CONSENT_TYPES.map((type) => ({ userId: id, type, version: docs.CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
  });
}
const loginAs = (id: string) => jar.set("rp_session", `tok-${id}`);

function put(body: BlobPart, name = "me.jpg", origin = ORIGIN) {
  const fd = new FormData();
  fd.set("photo", new File([body], name));
  return new Request(URL_, { method: "PUT", body: fd, headers: { origin, host: "localhost:3000", "user-agent": "ua" } });
}
const del = (origin = ORIGIN) => new Request(URL_, { method: "DELETE", headers: { origin, host: "localhost:3000", "user-agent": "ua" } });

let jpeg: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "ADMIN_EMAILS"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-photo-api-")), "storage");
  tdb = await createTestDb();
  docs = await import("@/lib/legal/consents");
  route = await import("./route");
  limits = await import("@/lib/auth/db-rate-limit");
  jpeg = new Uint8Array(await sharp({ create: { width: 800, height: 800, channels: 3, background: "#123456" } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "gps-like-secret" } } })
    .toBuffer());
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  await tdb.reset();
  await seed("ua");
  await seed("ub");
});

describe("/api/account/photo", () => {
  it("올리면 다시 만든 JPEG를 자기 자신에게만 내려준다(nosniff·private no-store·sandbox)", async () => {
    loginAs("ua");
    const res = await route.PUT(put(jpeg));
    expect(res.status).toBe(200);
    const { photoUrl } = (await res.json()) as { photoUrl: string };
    expect(photoUrl).toMatch(/^\/api\/account\/photo\?v=[A-Za-z0-9]+$/);

    const got = await route.GET();
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/jpeg");
    expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(got.headers.get("Cache-Control")).toBe("private, no-store");
    expect(got.headers.get("Content-Security-Policy")).toMatch(/^sandbox;/);
    const out = Buffer.from(await got.arrayBuffer());
    expect(await sharp(out).metadata()).toMatchObject({ format: "jpeg", width: 600, height: 800 });
    expect(out.includes(Buffer.from("gps-like-secret"))).toBe(false);

    // 다른 사용자는 자기 사진(없음)만 본다 — 남의 사진을 고르는 인자가 없다.
    loginAs("ub");
    expect((await route.GET()).status).toBe(404);
  });

  it("지우면 404, 로그인 안 하면 401", async () => {
    loginAs("ua");
    await route.PUT(put(jpeg));
    const res = await route.DELETE(del());
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    expect((await route.GET()).status).toBe(404);
    expect((await tdb.prisma.user.findUniqueOrThrow({ where: { id: "ua" } })).photoKey).toBeNull();
    jar.clear();
    expect((await route.GET()).status).toBe(401);
    expect((await route.PUT(put(jpeg))).status).toBe(401);
    expect((await route.DELETE(del())).status).toBe(401);
  });

  it("다른 출처의 올리기·지우기는 403(아무것도 바뀌지 않는다)", async () => {
    loginAs("ua");
    expect((await route.PUT(put(jpeg, "me.jpg", "https://evil.example"))).status).toBe(403);
    expect((await route.DELETE(del("https://evil.example"))).status).toBe(403);
    expect((await tdb.prisma.user.findUniqueOrThrow({ where: { id: "ua" } })).photoKey).toBeNull();
  });

  it("형식 415·5MB 초과 413·파일 없음 400, 하루 상한 429", async () => {
    loginAs("ua");
    expect((await route.PUT(put("GIF89a....", "a.gif"))).status).toBe(415);
    expect((await route.PUT(put(new Uint8Array(5 * 1024 * 1024 + 100_000)))).status).toBe(413);
    const empty = new Request(URL_, { method: "PUT", body: new FormData(), headers: { origin: ORIGIN, host: "localhost:3000", "user-agent": "ua" } });
    expect((await route.PUT(empty)).status).toBe(400);
    for (let i = 0; i < limits.PROFILE_PHOTO_LIMIT.limit; i++) await limits.hitDbLimit(limits.PROFILE_PHOTO_LIMIT, "ua");
    expect((await route.PUT(put(jpeg))).status).toBe(429);
  });
});
