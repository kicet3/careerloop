import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POSTING_CAPTURE } from "@/lib/domain/posting-capture";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-capture-run-"));
let cap: typeof import("./capture");
let store: typeof import("./capture-store");
let storage: typeof import("@/lib/storage");
let tdb: TestDb;

async function shared(id: string) {
  await tdb.prisma.sharedPosting.create({
    data: { id, urlKey: `example.com/${id}`, url: `https://example.com/${id}`, company: "A", roleTitle: "B", extractedBy: "anthropic", fetchedAt: new Date() },
  });
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  cap = await import("./capture");
  store = await import("./capture-store");
  storage = await import("@/lib/storage");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("planCapture", () => {
  it("상한·WebP 한계", () => {
    expect(cap.planCapture(3000)).toEqual({ height: 3000, mime: "image/webp", clipped: false });
    expect(cap.planCapture(16_383).mime).toBe("image/webp");
    expect(cap.planCapture(16_384)).toEqual({ height: 16_384, mime: "image/jpeg", clipped: false });
    expect(cap.planCapture(50_000)).toEqual({ height: POSTING_CAPTURE.maxHeight, mime: "image/jpeg", clipped: true });
    expect(cap.planCapture(Number.NaN).height).toBe(POSTING_CAPTURE.viewportHeight);
  });
});

describe("localChromePath", () => {
  it("CHROME_PATH → darwin 기본 → null", () => {
    expect(cap.localChromePath({ CHROME_PATH: "/x/chrome" }, "linux", (p) => p === "/x/chrome")).toBe("/x/chrome");
    expect(cap.localChromePath({ CHROME_PATH: "/x/none" }, "darwin", () => false)).toBeNull();
    expect(cap.localChromePath({}, "darwin", (p) => p === cap.MAC_CHROME_PATH)).toBe(cap.MAC_CHROME_PATH);
    expect(cap.localChromePath({}, "linux", () => true)).toBeNull();
  });
});

describe("hardenedArgs", () => {
  it("프록시 강제·루프백 우회 금지·QUIC/WebRTC UDP 차단", () => {
    const args = cap.hardenedArgs("http://127.0.0.1:1234");
    expect(args).toContain("--proxy-server=http://127.0.0.1:1234");
    expect(args).toContain("--proxy-bypass-list=<-loopback>");
    expect(args).toContain("--disable-quic");
    expect(args.some((a) => a.startsWith("--force-webrtc-ip-handling-policy="))).toBe(true);
  });
});

describe("capturePostingPage 첫 주소 검사", () => {
  it("내부 주소는 브라우저를 띄우기 전에 거절한다", async () => {
    const lookup = async () => [{ address: "10.0.0.1", family: 4 }];
    await expect(cap.capturePostingPage("https://intranet.example/job", { lookup })).rejects.toThrow(cap.PostingCaptureError);
    await expect(cap.capturePostingPage("http://127.0.0.1/", { lookup })).rejects.toThrow("외부에 공개된");
    await expect(cap.capturePostingPage("ftp://x.com/", { lookup })).rejects.toThrow(cap.PostingCaptureError);
  });
});

const png = Buffer.alloc(500, 7);

describe("runPostingCapture", () => {

  it("맡은 작업을 찍어 저장소에 넣고 done으로 기록한다", async () => {
    await shared("sp1");
    expect(await store.requestCapture("sp1")).toBe(true);
    const capture = vi.fn(async () => ({ body: png, mime: "image/webp" as const, width: 1280, height: 4000, clipped: false }));
    await cap.runPostingCapture("sp1", { capture });
    expect(capture).toHaveBeenCalledWith("https://example.com/sp1", expect.anything());
    const info = await store.getCaptureInfo("sp1");
    expect(info).toMatchObject({ status: "done", mime: "image/webp", bytes: 500, width: 1280, height: 4000, error: null });
    const obj = await store.getCaptureObject("sp1");
    expect(obj?.key).toBe("shared-postings/sp1/capture.webp");
    expect(await storage.getObject(obj!.key)).toEqual(png);
  });

  it("형식이 바뀌면 예전 파일을 지운다", async () => {
    expect(await store.requestCapture("sp1", { force: true })).toBe(true);
    await cap.runPostingCapture("sp1", { capture: async () => ({ body: png, mime: "image/jpeg", width: 1280, height: 18000, clipped: false }) });
    expect((await store.getCaptureObject("sp1"))?.key).toBe("shared-postings/sp1/capture.jpg");
    expect(await storage.getObject("shared-postings/sp1/capture.webp")).toBeNull();
  });

  it("맡을 작업이 없으면 찍지 않는다", async () => {
    await shared("sp2");
    const capture = vi.fn();
    await cap.runPostingCapture("sp2", { capture });
    await cap.runPostingCapture("missing", { capture });
    expect(capture).not.toHaveBeenCalled();
  });

  it("실패는 사용자용 문구만 기록하고 던지지 않는다", async () => {
    await shared("sp3");
    await store.requestCapture("sp3");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await cap.runPostingCapture("sp3", {
      capture: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:443");
      },
    });
    let info = await store.getCaptureInfo("sp3");
    expect(info).toMatchObject({ status: "failed", error: cap.CAPTURE_GENERIC_ERROR, retryable: true });
    expect(info?.error).not.toContain("10.0.0.1");

    await store.requestCapture("sp3");
    await cap.runPostingCapture("sp3", {
      capture: async () => {
        throw new cap.PostingCaptureError("원문 페이지가 오류를 돌려줬습니다(HTTP 404).");
      },
    });
    info = await store.getCaptureInfo("sp3");
    expect(info?.error).toBe("원문 페이지가 오류를 돌려줬습니다(HTTP 404).");
    errors.mockRestore();
  });
});

describe("queueCaptureForImport", () => {
  it("끝난 가져오기의 공용 공고에 예약, 다시 가져오기는 이미 찍은 것도 다시(force)", async () => {
    const imports = await import("./imports");
    await tdb.prisma.user.create({ data: { id: "uq", email: "uq@x.com" } });
    await shared("sq");
    const mk = (id: string, status: string, refresh = false) =>
      tdb.prisma.postingImport.create({ data: { id, userId: "uq", url: "https://example.com/sq", status, sharedPostingId: "sq", refresh } });
    await mk("i-run", "analyzing");
    expect(await imports.queueCaptureForImport("i-run")).toBeNull();
    await mk("i-ok", "completed");
    expect(await imports.queueCaptureForImport("i-ok")).toBe("sq");
    // 이미 예약됨 → 다시 예약하지 않는다.
    expect(await imports.queueCaptureForImport("i-ok")).toBeNull();
    await cap.runPostingCapture("sq", { capture: async () => ({ body: png, mime: "image/webp", width: 1280, height: 900, clipped: false }) });
    expect((await store.getCaptureInfo("sq"))?.status).toBe("done");
    // 보통 가져오기는 done을 건드리지 않고, 다시 가져오기는 다시 찍는다.
    expect(await imports.queueCaptureForImport("i-ok")).toBeNull();
    await mk("i-refresh", "completed", true);
    expect(await imports.queueCaptureForImport("i-refresh")).toBe("sq");
    expect(await imports.queueCaptureForImport("missing")).toBeNull();
  });
});

// 실제 브라우저로 한 장 찍어 본다: CAPTURE_LIVE_URL=https://... npx vitest run src/lib/postings/capture.test.ts
describe.skipIf(!process.env.CAPTURE_LIVE_URL)("live capture", () => {
  it(
    "공개 공고 페이지",
    async () => {
      const started = Date.now();
      const shot = await cap.capturePostingPage(process.env.CAPTURE_LIVE_URL!);
      const ms = Date.now() - started;
      console.log(`[live] ${shot.mime} ${shot.width}x${shot.height} clipped=${shot.clipped} ${shot.body.length}B ${ms}ms`);
      if (process.env.CAPTURE_LIVE_OUT) (await import("node:fs")).writeFileSync(process.env.CAPTURE_LIVE_OUT, shot.body);
      expect(shot.body.length).toBeGreaterThan(1000);
    },
    120_000,
  );
});
