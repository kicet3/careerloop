/** 이력서 지원 상태 기본값·첨부 없음. 보관함 포트폴리오 붙이기·떼기는 src/lib/portfolios/service.test.ts. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument, resumeApplyStatusOf } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-portfolio-"));
let service: typeof import("./service");
let tdb: TestDb;
let companyId: string;
let generalId: string;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  service = await import("./service");
  const base = { templateId: "classic" as const, document: emptyResumeDocument(), source: "manual" as const };
  companyId = (await service.createResume("ua", { ...base, company: "토스", roleTitle: "백엔드" })).resume.id;
  generalId = (await service.createResume("ua", { ...base, kind: "general", company: "", roleTitle: "" })).resume.id;
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("이력서 지원 상태 기본값", () => {
  it("새 지원처별 이력서는 '지원 전', 공용 이력서는 상태 없음", async () => {
    expect((await service.getResumeMeta("ua", companyId))!).toMatchObject({ applyStatus: "draft", submittedApplicationId: null, portfolio: null });
    expect((await service.getResumeMeta("ua", generalId))!.applyStatus).toBeNull();
  });

  it("행 값 해석: 모르는 값·null은 draft, 공용은 늘 null", () => {
    expect(resumeApplyStatusOf("company", null)).toBe("draft");
    expect(resumeApplyStatusOf("company", "weird")).toBe("draft");
    expect(resumeApplyStatusOf("company", "submitted")).toBe("submitted");
    expect(resumeApplyStatusOf("general", "submitted")).toBeNull();
  });
});
