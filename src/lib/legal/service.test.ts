/** 동의 기록(PGlite): 최신 행 기준 상태, 버전 변경 시 재동의, 마케팅 철회, 탈퇴 시 함께 삭제. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { CONSENT_DOCS } from "./consents";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let svc: typeof import("./service");

beforeAll(async () => {
  tdb = await createTestDb();
  svc = await import("./service");
  await tdb.prisma.user.create({ data: { id: "u", email: "u@x.com" } });
});
afterAll(() => tdb.close());

describe("동의 기록", () => {
  it("처음에는 필수 세 항목을 모두 받아야 한다", async () => {
    expect(await svc.getMissingConsents("u")).toEqual(["terms", "privacy", "age14"]);
  });

  it("가입 동의를 기록하면 통과, 문서 버전과 IP 해시·UA를 남긴다", async () => {
    const at = new Date(Date.now() - 60_000);
    await svc.recordConsents("u", { terms: true, privacy: true, age14: true, marketing: false }, { source: "signup", ipHash: "h", userAgent: "x".repeat(500), at });
    expect(await svc.getMissingConsents("u")).toEqual([]);
    const rows = await tdb.prisma.userConsent.findMany({ where: { userId: "u" } });
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.type === "terms")).toMatchObject({ version: CONSENT_DOCS.terms.version, agreed: true, source: "signup", ipHash: "h" });
    expect(rows[0]!.userAgent).toHaveLength(200);
    expect(rows[0]!.createdAt.toISOString()).toBe(at.toISOString());
  });

  it("예전 버전 동의만 있으면 다시 받는다", async () => {
    await tdb.prisma.userConsent.create({ data: { userId: "u", type: "terms", version: "1999-01-01", agreed: true, source: "gate", createdAt: new Date(Date.now() + 1000) } });
    expect(await svc.getMissingConsents("u")).toEqual(["terms"]);
    await svc.recordConsents("u", { terms: true }, { source: "gate", at: new Date(Date.now() + 2000) });
    expect(await svc.getMissingConsents("u")).toEqual([]);
  });

  it("마케팅 동의·철회는 최신 행이 이긴다", async () => {
    await svc.setMarketingConsent("u", true, { at: new Date(Date.now() + 3000) });
    expect((await svc.getLatestConsents("u")).marketing?.agreed).toBe(true);
    await svc.setMarketingConsent("u", false, { at: new Date(Date.now() + 4000) });
    expect((await svc.getLatestConsents("u")).marketing?.agreed).toBe(false);
    const history = await svc.listConsentHistory("u");
    expect(history[0]).toMatchObject({ type: "marketing", agreed: false, source: "account" });
  });

  it("사용자를 지우면 동의 기록도 지워진다", async () => {
    await tdb.prisma.user.delete({ where: { id: "u" } });
    expect(await tdb.prisma.userConsent.count()).toBe(0);
  });
});
