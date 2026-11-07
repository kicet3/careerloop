/** 회원 탈퇴(PGlite + 로컬 저장소): DB CASCADE, 저장소 접두사, 그래프 실패 시 중단, 공용 공고(URL·직접 입력)는 남고 created_by만 null. */
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
  await tdb.prisma.mcpToken.createMany({
    data: [
      { id: "mcp_a", userId: "ua", name: "a", tokenHash: "hash-a", prefix: "clp_aaaaaaaa" },
      { id: "mcp_b", userId: "ub", name: "b", tokenHash: "hash-b", prefix: "clp_bbbbbbbb" },
    ],
  });
  await tdb.prisma.notification.createMany({
    data: [
      { id: "n_a", userId: "ua", kind: "resume-draft-completed", title: "a" },
      { id: "n_b", userId: "ub", kind: "resume-draft-completed", title: "b" },
    ],
  });
  await tdb.prisma.resumeDraftJob.create({ data: { id: "dj_a", userId: "ua", runId: "r", label: "x", input: { jdText: "JD" } } });
  await storage.putJson(storage.userKey("ua", "resumes", "r1", "v1.json"), { a: 1 });
  await storage.putJson(storage.userKey("ub", "resumes", "r1", "v1.json"), { b: 1 });
  // 포트폴리오 원본·프로필 사진·큰 파일 임시 자리(uploads/<u>/)도 탈퇴 때 지운다.
  await storage.putObject(storage.userKey("ua", "portfolios", "p1", "original-x.pdf"), "%PDF-1.4");
  await storage.putObject(storage.userKey("ua", "profile", "photo-x.jpg"), "jpeg");
  await storage.putObject(storage.uploadStagingKey("ua", "portfolio-abc.pdf"), "%PDF-1.4");
  await storage.putObject(storage.uploadStagingKey("ub", "portfolio-abc.pdf"), "%PDF-1.4");
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
    expect((await tdb.prisma.mcpToken.findMany()).map((t) => t.id)).toEqual(["mcp_b"]);
    expect((await tdb.prisma.notification.findMany()).map((n) => n.id)).toEqual(["n_b"]);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: "sp" } })).toMatchObject({ createdBy: null, importerCount: 0 });
    expect(await storage.listByPrefix(storage.userPrefix("ua"))).toEqual([]);
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ua"))).toEqual([]);
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ub"))).toEqual(["uploads/ub/portfolio-abc.pdf"]);
    expect(existsSync(path.join(storageDir, "users", "ub", "resumes", "r1", "v1.json"))).toBe(true);
    expect(await account.deleteAccount("ua", { deleteGraph: graph })).toEqual({ ok: false, reason: "not_found" });
  });

  it("직접 입력·URL 공용 공고는 모두 남고(created_by null) 담은 수를 다시 센다 — 메모·상태 등 개인 데이터는 지운다", async () => {
    const { PostingCreateInputSchema } = await import("@/lib/domain/postings");
    const service = await import("@/lib/postings/service");
    const shared = await import("@/lib/postings/shared");
    for (const id of ["uc", "ud"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
    const input = (over: Record<string, unknown>) =>
      PostingCreateInputSchema.parse({ company: "회사", roleTitle: "직무", jdText: "주요 업무\n- 개발", note: "uc의 메모", status: "applied", ...over });
    const manual = await service.createPosting("uc", input({}));
    await tdb.prisma.sharedPosting.create({
      data: { id: "sp-url", urlKey: "y.com/1", url: "https://y.com/1", company: "y", roleTitle: "r", extractedBy: "anthropic", createdBy: "uc", fetchedAt: new Date() },
    });
    const byUrl = await shared.saveSharedToLibrary("uc", "sp-url");
    await shared.saveSharedToLibrary("ud", manual.sharedPostingId!);
    await tdb.prisma.application.create({ data: { id: "app-uc", userId: "uc", company: "회사", roleTitle: "직무", postingId: manual.id } });
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: manual.sharedPostingId! } })).toMatchObject({ importerCount: 2 });

    expect(await account.deleteAccount("uc", { deleteGraph: async () => {}, deleteStorage: async () => {} })).toEqual({ ok: true });
    expect(await tdb.prisma.user.count({ where: { id: "uc" } })).toBe(0);
    expect(await tdb.prisma.jobPosting.count({ where: { userId: "uc" } })).toBe(0);
    expect(await tdb.prisma.jobPosting.count({ where: { id: byUrl.posting.id } })).toBe(0);
    expect(await tdb.prisma.application.count({ where: { userId: "uc" } })).toBe(0);
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: manual.sharedPostingId! } })).toMatchObject({
      createdBy: null,
      importerCount: 1,
      url: null,
      company: "회사",
    });
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: "sp-url" } })).toMatchObject({ createdBy: null, importerCount: 0 });
    const left = JSON.stringify(await tdb.prisma.sharedPosting.findMany());
    expect(left).not.toContain("uc의 메모");
    // 담은 다른 사용자의 사본은 그대로, 공고 찾기에도 계속 보인다.
    expect(await tdb.prisma.jobPosting.count({ where: { userId: "ud", sharedPostingId: manual.sharedPostingId } })).toBe(1);
    expect((await shared.listSharedPostings()).items.map((i) => i.id)).toContain(manual.sharedPostingId);
  });
});
