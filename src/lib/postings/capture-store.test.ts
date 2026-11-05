import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POSTING_CAPTURE } from "@/lib/domain/posting-capture";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-capture-"));
let cap: typeof import("./capture-store");
let storage: typeof import("@/lib/storage");
let tdb: TestDb;

async function shared(id: string, hidden = false) {
  await tdb.prisma.sharedPosting.create({
    data: {
      id,
      urlKey: `example.com/${id}`,
      url: `https://example.com/${id}`,
      company: "A",
      roleTitle: "B",
      extractedBy: "anthropic",
      fetchedAt: new Date(),
      hiddenAt: hidden ? new Date() : null,
    },
  });
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  cap = await import("./capture-store");
  storage = await import("@/lib/storage");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("공고 원문 캡처 상태", () => {
  it("키는 공용 공고 접두사 아래, 저장소에 쓰고 읽을 수 있다", async () => {
    const key = cap.postingCaptureKey("sp1");
    expect(key).toBe("shared-postings/sp1/capture.webp");
    expect(cap.postingCaptureKey("sp1", "image/jpeg")).toBe("shared-postings/sp1/capture.jpg");
    await storage.putObject(key, Buffer.from([1, 2, 3]), { contentType: "image/webp" });
    expect([...(await storage.getObject(key))!]).toEqual([1, 2, 3]);
    expect(await storage.listByPrefix(storage.sharedPostingPrefix("sp1"))).toEqual([key]);
    await storage.deleteObject(key);
    expect(() => storage.sharedPostingKey("..", "x")).toThrow();
  });

  it("예약 → 맡기 → 성공, 중복 예약·맡기는 막는다", async () => {
    await shared("s1");
    expect(await cap.getCaptureInfo("s1")).toMatchObject({ status: "none", retryable: true });
    expect(await cap.requestCapture("s1")).toBe(true);
    expect(await cap.requestCapture("s1")).toBe(false);
    expect(await cap.claimCapture("s1")).toEqual({ url: "https://example.com/s1", attempt: 1 });
    expect(await cap.claimCapture("s1")).toBeNull();
    expect((await cap.getCaptureInfo("s1"))!.status).toBe("running");

    const key = cap.postingCaptureKey("s1");
    expect(await cap.recordCaptureSuccess("s1", { key, mime: "image/webp", bytes: 1234, width: 1280, height: 5000 })).toBe(true);
    expect(await cap.recordCaptureFailure("s1", "늦은 실패")).toBe(false);
    const info = (await cap.getCaptureInfo("s1"))!;
    expect(info).toMatchObject({ status: "done", mime: "image/webp", bytes: 1234, width: 1280, height: 5000, error: null, retryable: false });
    expect(info.capturedAt).toBeGreaterThan(0);
    expect(await cap.getCaptureObject("s1")).toMatchObject({ key, mime: "image/webp" });
    // 끝난 캡처는 force(다시 가져오기)일 때만 다시 찍는다.
    expect(await cap.requestCapture("s1")).toBe(false);
    expect(await cap.requestCapture("s1", { force: true })).toBe(true);
  });

  it("실패는 시도 상한까지 다시 시도, 멈춘 작업은 실패로 보이고 다시 맡을 수 있다", async () => {
    await shared("s2");
    for (let i = 0; i < POSTING_CAPTURE.maxAttempts; i++) {
      expect(await cap.requestCapture("s2")).toBe(true);
      expect(await cap.claimCapture("s2")).not.toBeNull();
      expect(await cap.recordCaptureFailure("s2", "페이지를 열지 못했습니다.")).toBe(true);
    }
    expect(await cap.getCaptureInfo("s2")).toMatchObject({ status: "failed", error: "페이지를 열지 못했습니다.", retryable: false });
    expect(await cap.requestCapture("s2")).toBe(false);
    expect(await cap.getCaptureObject("s2")).toBeNull();

    await shared("s3");
    const t0 = Date.now();
    await cap.requestCapture("s3", { now: t0 });
    await cap.claimCapture("s3", t0);
    const later = t0 + POSTING_CAPTURE.staleMs + 1000;
    expect(await cap.getCaptureInfo("s3", later)).toMatchObject({ status: "failed", retryable: true });
    expect(await cap.claimCapture("s3", later)).toMatchObject({ attempt: 2 });
  });

  it("볼 수 있는 사람: 숨기지 않은 공고는 모두, 숨긴 공고는 보관함에 담은 사용자·관리자", async () => {
    await shared("s4", true);
    await tdb.prisma.jobPosting.create({ data: { id: "jp1", userId: "ua", company: "A", roleTitle: "B", sharedPostingId: "s4" } });
    expect(await cap.canViewCapture("ub", "s1")).toBe(true);
    expect(await cap.canViewCapture("ua", "s4")).toBe(true);
    expect(await cap.canViewCapture("ub", "s4")).toBe(false);
    expect(await cap.canViewCapture("ub", "s4", { isAdmin: true })).toBe(true);
    expect(await cap.canViewCapture("ua", "nope")).toBe(false);
    expect(await cap.sharedIdForPosting("ua", "jp1")).toBe("s4");
    expect(await cap.sharedIdForPosting("ub", "jp1")).toBeNull();
  });
});
