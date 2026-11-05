import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument, MAX_RESUME_PORTFOLIO_CHARS, resumeApplyStatusOf } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-portfolio-"));
let portfolio: typeof import("./portfolio");
let service: typeof import("./service");
let storage: typeof import("@/lib/storage");
let tdb: TestDb;
let companyId: string;
let generalId: string;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  portfolio = await import("./portfolio");
  service = await import("./service");
  storage = await import("@/lib/storage");
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

describe("이력서 첨부 포트폴리오", () => {
  it("파일 텍스트 저장 → URL로 바꾸면 텍스트 삭제 → 떼기", async () => {
    expect(await portfolio.setPortfolioFile("ub", companyId, { fileName: "p.pdf", text: "x" })).toBeNull();

    const long = "가".repeat(MAX_RESUME_PORTFOLIO_CHARS + 10);
    const r = (await portfolio.setPortfolioFile("ua", companyId, { fileName: "포트폴리오.pdf", text: `  ${long}\u0000 ` }))!;
    expect(r.truncated).toBe(true);
    expect(r.resume.portfolio).toMatchObject({ kind: "file", fileName: "포트폴리오.pdf", url: null, chars: MAX_RESUME_PORTFOLIO_CHARS });
    const key = (await tdb.prisma.companyResume.findUnique({ where: { id: companyId } }))!.portfolioTextKey!;
    expect(key).toMatch(new RegExp(`^users/ua/resumes/${companyId}/portfolio-[a-z0-9]+\\.txt$`));
    // 다시 올리면 새 키에 쓰고 옛 텍스트는 지운다.
    await portfolio.setPortfolioFile("ua", companyId, { fileName: "b.pdf", text: "두 번째" });
    const key2 = (await tdb.prisma.companyResume.findUnique({ where: { id: companyId } }))!.portfolioTextKey!;
    expect(key2).not.toBe(key);
    expect(await storage.getObject(key)).toBeNull();
    await portfolio.setPortfolioFile("ua", companyId, { fileName: "포트폴리오.pdf", text: long });
    const key3 = (await tdb.prisma.companyResume.findUnique({ where: { id: companyId } }))!.portfolioTextKey!;
    const got = (await portfolio.getPortfolioText("ua", companyId))!;
    expect(got.text!.length).toBe(MAX_RESUME_PORTFOLIO_CHARS);
    expect(await portfolio.getPortfolioText("ub", companyId)).toBeNull();

    const u = (await portfolio.setPortfolioUrl("ua", companyId, "https://example.com/pf"))!;
    expect(u.portfolio).toMatchObject({ kind: "url", url: "https://example.com/pf", fileName: null, chars: null });
    expect(await storage.getObject(key3)).toBeNull();
    expect(await portfolio.getPortfolioText("ua", companyId)).toMatchObject({ text: null, info: { kind: "url" } });

    // 목록에도 실린다.
    const listed = (await service.listResumes("ua")).find((x) => x.id === companyId)!;
    expect(listed.portfolio?.kind).toBe("url");

    expect((await portfolio.removePortfolio("ua", companyId))!.portfolio).toBeNull();
    expect(await portfolio.getPortfolioText("ua", companyId)).toEqual({ info: null, text: null });
    expect(await portfolio.removePortfolio("ub", companyId)).toBeNull();
  });

  it("이력서를 지우면 포트폴리오 텍스트도 지워진다", async () => {
    await portfolio.setPortfolioFile("ua", generalId, { fileName: "a.txt", text: "공용 포트폴리오 본문" });
    const key = (await tdb.prisma.companyResume.findUnique({ where: { id: generalId } }))!.portfolioTextKey!;
    expect(await storage.getObject(key)).not.toBeNull();
    expect(await service.deleteResume("ua", generalId)).toBe(true);
    expect(await storage.getObject(key)).toBeNull();
  });
});
