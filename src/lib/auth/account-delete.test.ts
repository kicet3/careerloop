/** 회원 탈퇴(PGlite + 로컬 저장소): DB CASCADE, 저장소 접두사, 그래프 실패 시 중단, 공용 공고는 남고 created_by만 null. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let account: typeof import("./account");
let storage: typeof import("@/lib/storage");
const storageDir = path.join(mkdtempSync(path.join(tmpdir(), "rp-account-del-")), "storage");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = storageDir;
  tdb = await createTestDb();
  account = await import("./account");
  storage = await import("@/lib/storage");
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  await tdb.prisma.session.create({ data: { id: "s", userId: "ua", expiresAt: new Date(Date.now() + 1e6) } });
  await tdb.prisma.userConsent.create({ data: { userId: "ua", type: "terms", version: "v", agreed: true, source: "signup" } });
  await tdb.prisma.sharedPosting.create({
    data: { id: "sp", urlKey: "x.com/1", url: "https://x.com/1", company: "c", roleTitle: "r", extractedBy: "anthropic", createdBy: "ua", importerCount: 1, fetchedAt: new Date() },
  });
  await tdb.prisma.jobPosting.create({ data: { id: "jp", userId: "ua", company: "c", roleTitle: "r", sharedPostingId: "sp" } });
  await tdb.prisma.rateEvent.createMany({ data: [{ bucket: "resume-draft", key: "ua" }, { bucket: "resume-draft", key: "ub" }] });
  await storage.putJson(storage.userKey("ua", "resumes", "r1", "v1.json"), { a: 1 });
  await storage.putJson(storage.userKey("ub", "resumes", "r1", "v1.json"), { b: 1 });
});
afterAll(() => tdb.close());

describe("deleteAccount", () => {
  it("그래프 삭제가 실패하면 아무것도 지우지 않는다", async () => {
    const r = await account.deleteAccount("ua", { deleteGraph: async () => Promise.reject(new Error("neo4j down")) });
    expect(r).toEqual({ ok: false, reason: "graph_failed" });
    expect(await tdb.prisma.user.count({ where: { id: "ua" } })).toBe(1);
  });

  it("저장소 삭제가 실패하면 DB 행을 지우지 않는다(다시 시도할 수 있게)", async () => {
    const r = await account.deleteAccount("ua", { deleteGraph: async () => {}, deleteStorage: async () => Promise.reject(new Error("r2 down")) });
    expect(r).toEqual({ ok: false, reason: "storage_failed" });
    expect(await tdb.prisma.user.count({ where: { id: "ua" } })).toBe(1);
    expect(await tdb.prisma.jobPosting.count()).toBe(1);
  });

  it("사용자 데이터·저장소 객체를 지우고 다른 사용자 것은 남긴다", async () => {
    const graph = vi.fn(async () => {});
    expect(await account.deleteAccount("ua", { deleteGraph: graph })).toEqual({ ok: true });
    expect(graph).toHaveBeenCalledWith("ua");
    expect(await tdb.prisma.user.count({ where: { id: "ua" } })).toBe(0);
    expect(await tdb.prisma.session.count()).toBe(0);
    expect(await tdb.prisma.userConsent.count()).toBe(0);
    expect(await tdb.prisma.jobPosting.count()).toBe(0);
    expect((await tdb.prisma.rateEvent.findMany()).map((r) => r.key)).toEqual(["ub"]);
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: "sp" } })).toMatchObject({ createdBy: null, importerCount: 0 });
    expect(await storage.listByPrefix(storage.userPrefix("ua"))).toEqual([]);
    expect(existsSync(path.join(storageDir, "users", "ub", "resumes", "r1", "v1.json"))).toBe(true);
    expect(await account.deleteAccount("ua", { deleteGraph: graph })).toEqual({ ok: false, reason: "not_found" });
  });
});
