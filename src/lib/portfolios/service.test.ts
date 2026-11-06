/** 포트폴리오 보관함 서비스(PGlite + 로컬 저장소): 만들기·고치기·내용 바꾸기·지우기, 소유권, 상한, 이력서 붙이기·떼기·지우면 떨어짐. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PORTFOLIO_TEXT_CHARS } from "@/lib/domain/portfolios";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-portfolios-"));
let svc: typeof import("./service");
let attach: typeof import("@/lib/resumes/portfolio");
let resumes: typeof import("@/lib/resumes/service");
let storage: typeof import("@/lib/storage");
let tdb: TestDb;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  svc = await import("./service");
  attach = await import("@/lib/resumes/portfolio");
  resumes = await import("@/lib/resumes/service");
  storage = await import("@/lib/storage");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

let resumeId: string;
let otherResumeId: string;
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  const base = { templateId: "classic" as const, document: emptyResumeDocument(), source: "manual" as const };
  resumeId = (await resumes.createResume("ua", { ...base, company: "토스", roleTitle: "백엔드" })).resume.id;
  otherResumeId = (await resumes.createResume("ua", { ...base, kind: "general", company: "", roleTitle: "" })).resume.id;
});

const keyOf = async (id: string) => (await tdb.prisma.portfolio.findUnique({ where: { id } }))!.textKey;

describe("포트폴리오 보관함", () => {
  it("파일로 만들기: 글자 수 상한·NUL 제거, 이름 기본값은 파일 이름, 키는 users/<u>/portfolios/<id>/", async () => {
    const long = "가".repeat(MAX_PORTFOLIO_TEXT_CHARS + 10);
    const { portfolio: p, truncated } = await svc.createPortfolioFromFile("ua", { fileName: "정산.pdf", text: `  ${long}\u0000 `, description: "  역할 메모  " });
    expect(truncated).toBe(true);
    expect(p).toMatchObject({ title: "정산.pdf", kind: "file", fileName: "정산.pdf", url: null, chars: MAX_PORTFOLIO_TEXT_CHARS, description: "역할 메모" });
    expect(p.id).toMatch(/^[0-9A-Za-z]{16}$/);
    const key = (await keyOf(p.id))!;
    expect(key).toMatch(new RegExp(`^users/ua/portfolios/${p.id}/text-[a-z0-9]+\\.txt$`));
    const got = (await svc.getPortfolioText("ua", p.id))!;
    expect(got.text!.length).toBe(MAX_PORTFOLIO_TEXT_CHARS);
    expect(await svc.getPortfolioText("ub", p.id)).toBeNull();
    expect(await svc.getPortfolio("ub", p.id)).toBeNull();
  });

  it("링크로 만들기: 이름 기본값은 호스트, 텍스트 없음", async () => {
    const p = await svc.createPortfolioFromUrl("ua", { url: "https://me.dev/work?x=1" });
    expect(p).toMatchObject({ title: "me.dev", kind: "url", url: "https://me.dev/work?x=1", fileName: null, chars: null, description: null });
    expect((await svc.getPortfolioText("ua", p.id))!.text).toBeNull();
    const named = await svc.createPortfolioFromUrl("ua", { url: "https://a.b", title: "  깃허브  " });
    expect(named.title).toBe("깃허브");
  });

  it("목록: 최근 수정 순, 붙인 이력서 함께, 남의 것은 안 보인다", async () => {
    const a = await svc.createPortfolioFromUrl("ua", { url: "https://a.dev" });
    const b = (await svc.createPortfolioFromFile("ua", { fileName: "b.md", text: "본문" })).portfolio;
    await svc.createPortfolioFromUrl("ub", { url: "https://other.dev" });
    expect((await attach.attachPortfolio("ua", resumeId, a.id)).ok).toBe(true);
    const list = await svc.listPortfolios("ua");
    expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(list.find((p) => p.id === a.id)!.resumes).toEqual([{ id: resumeId, title: "토스 백엔드", kind: "company" }]);
    expect(list.find((p) => p.id === b.id)!.resumes).toEqual([]);
  });

  it("이름·설명 고치기: 빈 이름은 무시, 설명 null이면 지운다, 남의 것은 null", async () => {
    const p = await svc.createPortfolioFromUrl("ua", { url: "https://a.dev", description: "처음" });
    expect(await svc.updatePortfolio("ua", p.id, { title: "새 이름", description: "  바뀐 설명 " })).toMatchObject({ title: "새 이름", description: "바뀐 설명" });
    expect(await svc.updatePortfolio("ua", p.id, { title: "   ", description: null })).toMatchObject({ title: "새 이름", description: null });
    expect(await svc.updatePortfolio("ub", p.id, { title: "x" })).toBeNull();
  });

  it("내용 바꾸기: 새 키에 쓰고 옛 텍스트는 지운다, 링크로 바꾸면 텍스트 삭제, 남의 것은 null", async () => {
    const { portfolio: p } = await svc.createPortfolioFromFile("ua", { fileName: "a.md", text: "첫 번째", title: "내 포폴" });
    const k1 = (await keyOf(p.id))!;
    expect(await svc.replacePortfolioFile("ub", p.id, { fileName: "x.md", text: "x" })).toBeNull();
    const r = (await svc.replacePortfolioFile("ua", p.id, { fileName: "b.md", text: "두 번째" }))!;
    expect(r.portfolio).toMatchObject({ title: "내 포폴", fileName: "b.md", chars: 4 });
    const k2 = (await keyOf(p.id))!;
    expect(k2).not.toBe(k1);
    expect(await storage.getObject(k1)).toBeNull();
    expect((await svc.getPortfolioText("ua", p.id))!.text).toBe("두 번째");

    expect(await svc.replacePortfolioUrl("ub", p.id, "https://x.dev")).toBeNull();
    expect(await svc.replacePortfolioUrl("ua", p.id, "https://me.dev")).toMatchObject({ kind: "url", url: "https://me.dev", fileName: null, chars: null, title: "내 포폴" });
    expect(await storage.getObject(k2)).toBeNull();
    expect(await keyOf(p.id)).toBeNull();
  });

  it("개수 제한이 없다: 많이 있어도 새로 만들 수 있고 목록은 모두 보여 준다", async () => {
    const n = 45;
    await tdb.prisma.portfolio.createMany({
      data: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, userId: "ua", title: `p${i}`, kind: "url", url: "https://a.dev" })),
    });
    await expect(svc.createPortfolioFromUrl("ua", { url: "https://a.dev" })).resolves.toMatchObject({ kind: "url" });
    await expect(svc.createPortfolioFromFile("ua", { fileName: "a.md", text: "x" })).resolves.toMatchObject({ portfolio: { kind: "file" } });
    expect(await svc.listPortfolios("ua")).toHaveLength(n + 2);
  });

  it("지우기: 붙인 이력서에서 떨어지고(이력서는 남는다) 저장한 글도 지운다, 남의 것은 null", async () => {
    const { portfolio: p } = await svc.createPortfolioFromFile("ua", { fileName: "a.md", text: "본문" });
    const key = (await keyOf(p.id))!;
    await attach.attachPortfolio("ua", resumeId, p.id);
    await attach.attachPortfolio("ua", otherResumeId, p.id);
    expect(await svc.deletePortfolio("ub", p.id)).toBeNull();
    expect(await svc.deletePortfolio("ua", p.id)).toEqual({ detached: 2 });
    expect(await storage.getObject(key)).toBeNull();
    expect(await resumes.getResumeMeta("ua", resumeId)).toMatchObject({ id: resumeId, portfolio: null });
    expect(await resumes.getResumeMeta("ua", otherResumeId)).toMatchObject({ portfolio: null });
    expect(await svc.deletePortfolio("ua", p.id)).toBeNull();
  });
});

describe("이력서 첨부(보관함 항목 붙이기·떼기)", () => {
  it("붙이기 → 바꾸기 → 떼기: 떼도 보관함 항목·글은 남는다", async () => {
    const { portfolio: a } = await svc.createPortfolioFromFile("ua", { fileName: "a.md", text: "A 본문", description: "A 메모" });
    const b = await svc.createPortfolioFromUrl("ua", { url: "https://b.dev" });
    const r1 = await attach.attachPortfolio("ua", resumeId, a.id);
    expect(r1.ok && r1.resume.portfolio).toMatchObject({ id: a.id, kind: "file", fileName: "a.md", description: "A 메모" });
    expect(await attach.getResumePortfolioText("ua", resumeId)).toMatchObject({ info: { id: a.id }, text: "A 본문" });

    const r2 = await attach.attachPortfolio("ua", resumeId, b.id);
    expect(r2.ok && r2.resume.portfolio).toMatchObject({ id: b.id, kind: "url" });
    expect(await attach.getResumePortfolioText("ua", resumeId)).toMatchObject({ info: { id: b.id }, text: null });
    // 목록에도 실린다.
    expect((await resumes.listResumes("ua")).find((x) => x.id === resumeId)!.portfolio?.id).toBe(b.id);

    expect((await attach.detachPortfolio("ua", resumeId))!.portfolio).toBeNull();
    expect(await attach.getResumePortfolioText("ua", resumeId)).toEqual({ info: null, text: null });
    expect((await svc.getPortfolioText("ua", a.id))!.text).toBe("A 본문");
    expect(await svc.getPortfolio("ua", b.id)).not.toBeNull();
  });

  it("소유권: 남의 포트폴리오·남의 이력서는 붙이지 못한다", async () => {
    const mine = await svc.createPortfolioFromUrl("ua", { url: "https://a.dev" });
    const theirs = await svc.createPortfolioFromUrl("ub", { url: "https://b.dev" });
    expect(await attach.attachPortfolio("ua", resumeId, theirs.id)).toEqual({ ok: false, reason: "portfolio_not_found" });
    expect(await attach.attachPortfolio("ub", resumeId, theirs.id)).toEqual({ ok: false, reason: "resume_not_found" });
    expect(await attach.attachPortfolio("ub", resumeId, mine.id)).toEqual({ ok: false, reason: "resume_not_found" });
    expect(await attach.attachPortfolio("ub", "nope", mine.id)).toEqual({ ok: false, reason: "resume_not_found" });
    expect(await attach.attachPortfolio("ua", "nope", mine.id)).toEqual({ ok: false, reason: "resume_not_found" });
    expect(await attach.detachPortfolio("ub", resumeId)).toBeNull();
    expect(await attach.getResumePortfolioText("ub", resumeId)).toBeNull();
  });

  it("이력서를 지워도 붙인 포트폴리오는 남고, 이력서 접두사에 있던 옮긴 텍스트 키도 남긴다", async () => {
    const { portfolio: p } = await svc.createPortfolioFromFile("ua", { fileName: "a.md", text: "새 본문" });
    await attach.attachPortfolio("ua", resumeId, p.id);
    // 예전 이력서 첨부에서 옮긴 항목: 텍스트가 users/ua/resumes/<이력서>/ 아래에 있다.
    const legacyKey = storage.userKey("ua", "resumes", otherResumeId, "portfolio-legacy.txt");
    const strayKey = storage.userKey("ua", "resumes", otherResumeId, "stray.txt");
    await storage.putObject(legacyKey, "옮긴 본문");
    await storage.putObject(strayKey, "남은 객체");
    await tdb.prisma.portfolio.create({ data: { id: "legacy1", userId: "ua", title: "옮긴 것", kind: "file", fileName: "old.pdf", textKey: legacyKey, chars: 5 } });
    await attach.attachPortfolio("ua", otherResumeId, "legacy1");

    expect(await resumes.deleteResume("ua", resumeId)).toBe(true);
    expect((await svc.getPortfolioText("ua", p.id))!.text).toBe("새 본문");
    expect(await resumes.deleteResume("ua", otherResumeId)).toBe(true);
    expect(await storage.getObject(legacyKey)).not.toBeNull();
    expect(await storage.getObject(strayKey)).toBeNull();
    expect((await svc.getPortfolio("ua", "legacy1"))!.resumes).toEqual([]);
    // 포트폴리오를 지우면 옮긴 키도 지운다.
    await svc.deletePortfolio("ua", "legacy1");
    expect(await storage.getObject(legacyKey)).toBeNull();
  });

  it("회원 탈퇴(사용자 행 삭제)는 포트폴리오 행도 지운다(CASCADE)", async () => {
    await svc.createPortfolioFromUrl("ua", { url: "https://a.dev" });
    await tdb.prisma.user.delete({ where: { id: "ua" } });
    expect(await tdb.prisma.portfolio.count({ where: { userId: "ua" } })).toBe(0);
  });
});
