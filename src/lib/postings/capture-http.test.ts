/**
 * 원문 캡처 라우트 공용 처리(PGlite 테스트 DB, 로컬 저장소): 볼 권한(공고 찾기 노출·보관·관리자·직접 입력 공고),
 * 이미지 응답 헤더, 다시 시도(상태별 응답·레이트 리밋·시도 상한·after 예약).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTING_CAPTURE } from "@/lib/domain/posting-capture";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const scheduled = vi.hoisted(() => ({ fns: [] as (() => unknown)[] }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => scheduled.fns.push(fn) }));
vi.mock("./capture", () => ({ runPostingCapture: vi.fn(async () => {}) }));

const dir = mkdtempSync(path.join(tmpdir(), "rp-capture-http-"));
let h: typeof import("./capture-http");
let store: typeof import("./capture-store");
let storage: typeof import("@/lib/storage");
let tdb: TestDb;

const ua = { id: "ua", role: "user" as const };
const ub = { id: "ub", role: "user" as const };
const admin = { id: "ad", role: "admin" as const };

async function shared(id: string, opts: { hidden?: boolean } = {}) {
  await tdb.prisma.sharedPosting.create({
    data: {
      id,
      urlKey: `example.com/${id}`,
      url: `https://example.com/${id}`,
      company: "A",
      roleTitle: "B",
      extractedBy: "anthropic",
      fetchedAt: new Date(),
      hiddenAt: opts.hidden ? new Date() : null,
    },
  });
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub", "ad"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  await shared("pub");
  await shared("hid", { hidden: true });
  await tdb.prisma.jobPosting.create({ data: { id: "pa", userId: "ua", company: "A", roleTitle: "B", sharedPostingId: "hid", extractedBy: "x" } });
  await tdb.prisma.jobPosting.create({ data: { id: "pm", userId: "ua", company: "A", roleTitle: "B", extractedBy: "manual" } });
  h = await import("./capture-http");
  store = await import("./capture-store");
  storage = await import("@/lib/storage");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  scheduled.fns.length = 0;
});

describe("resolveCaptureTarget", () => {
  it("공고 찾기에 보이는 공고는 누구나, 숨긴 공고는 보관한 사용자·관리자만", async () => {
    expect(await h.resolveCaptureTarget(ub, { sharedId: "pub" })).toBe("pub");
    expect(await h.resolveCaptureTarget(ub, { sharedId: "hid" })).toBeNull();
    expect(await h.resolveCaptureTarget(ua, { sharedId: "hid" })).toBe("hid");
    expect(await h.resolveCaptureTarget(admin, { sharedId: "hid" })).toBe("hid");
    expect(await h.resolveCaptureTarget(ua, { sharedId: "nope" })).toBeNull();
  });
  it("내 공고 id → 공용 공고. 남의 공고·직접 입력 공고는 null", async () => {
    expect(await h.resolveCaptureTarget(ua, { postingId: "pa" })).toBe("hid");
    expect(await h.resolveCaptureTarget(ub, { postingId: "pa" })).toBeNull();
    expect(await h.resolveCaptureTarget(ua, { postingId: "pm" })).toBeNull();
  });
});

describe("captureImageResponse", () => {
  it("없으면 404, 있으면 비공개 캐시·nosniff로 바이트", async () => {
    expect((await h.captureImageResponse(null, "t")).status).toBe(404);
    expect((await h.captureImageResponse("pub", "t")).status).toBe(404);
    await store.requestCapture("pub");
    await store.claimCapture("pub");
    const key = store.postingCaptureKey("pub");
    await storage.putObject(key, Buffer.from("RIFFxxxxWEBP"), { contentType: "image/webp" });
    await store.recordCaptureSuccess("pub", { key, mime: "image/webp", bytes: 12, width: 1280, height: 900 });
    const res = await h.captureImageResponse("pub", "t");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("RIFFxxxxWEBP");
  });
});

describe("captureRetryResponse", () => {
  it("이미 저장돼 있으면 200으로 지금 상태(횟수 안 씀)", async () => {
    const res = await h.captureRetryResponse(ua, "pub", "t");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { capture: { status: string } }).capture.status).toBe("done");
    expect(scheduled.fns).toHaveLength(0);
  });

  it("없음·실패면 예약하고 after로 찍는다. 찍는 중이면 다시 예약하지 않는다", async () => {
    await shared("r1");
    const res = await h.captureRetryResponse(ua, "r1", "t");
    expect(res.status).toBe(202);
    expect(((await res.json()) as { capture: { status: string } }).capture.status).toBe("pending");
    expect(scheduled.fns).toHaveLength(1);
    const again = await h.captureRetryResponse(ua, "r1", "t");
    expect(again.status).toBe(202);
    expect(scheduled.fns).toHaveLength(1);
  });

  it("공고별 1시간 3회 제한 → 429 + Retry-After", async () => {
    await shared("r2");
    const fail = async () => {
      await store.requestCapture("r2");
      await store.claimCapture("r2");
      await store.recordCaptureFailure("r2", "실패");
    };
    for (let i = 0; i < 3; i++) {
      await fail();
      expect((await h.captureRetryResponse(ub, "r2", "t")).status).toBe(202);
    }
    await fail();
    const res = await h.captureRetryResponse(ub, "r2", "t");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("시도 상한을 넘은 실패는 409", async () => {
    await shared("r3");
    await tdb.prisma.sharedPosting.update({
      where: { id: "r3" },
      data: { captureStatus: "failed", captureAttempts: POSTING_CAPTURE.maxAttempts, captureError: "x" },
    });
    expect((await h.captureRetryResponse(ua, "r3", "t")).status).toBe(409);
  });
});
