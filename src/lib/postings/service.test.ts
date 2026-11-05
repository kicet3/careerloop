/**
 * 공고 저장소·가져오기 작업(실제 SQLite 임시 파일, 페이지 가져오기·LLM은 가짜): 소유권, 중복 URL 409,
 * 마감 합치기, 가져오기 동시 실행 1회·안전한 오류·멈춘 작업 재실행, 진단·이력서의 공고 연결.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-postings-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let service: typeof import("./service");
let imports: typeof import("./imports");
let db: typeof import("@/lib/db/client").db;
let schema: typeof import("@/lib/db/client").schema;
let FeatureError: typeof import("@/lib/api/errors").FeatureError;

const input = (v: Record<string, unknown>) => PostingCreateInputSchema.parse(v);
const PAGE_HTML = `<div>회사: 페이랩</div><div>모집 직무: 백엔드 개발자</div><div>근무지: 서울</div><div>접수 마감: 2026.11.20 18:00</div><p>${"정규직 백엔드 개발자를 채용합니다. Python과 SQL 경험이 필요합니다. ".repeat(5)}</p>`;

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  ({ db, schema } = await import("@/lib/db/client"));
  for (const id of ["ua", "ub"]) await db.insert(schema.users).values({ id, email: `${id}@x.com`, passwordHash: "x" });
  service = await import("./service");
  imports = await import("./imports");
  ({ FeatureError } = await import("@/lib/api/errors"));
});

afterAll(() => db.$client.close());

describe("공고 저장소", () => {
  it("만들고 읽고, 남의 공고는 없는 것과 같다", async () => {
    const p = await service.createPosting("ua", input({ company: "토스", roleTitle: "Server Developer", url: "www.toss.im/career/1?utm_source=x", jdText: "JD" }));
    expect(p).toMatchObject({ company: "토스", url: "https://www.toss.im/career/1?utm_source=x", urlKey: "toss.im/career/1", platform: "toss.im", extractedBy: "manual" });
    expect(await service.getPosting("ua", p.id)).toMatchObject({ id: p.id, jdText: "JD" });
    expect(await service.getPosting("ub", p.id)).toBeNull();
    expect(await service.updatePosting("ub", p.id, { status: "closed" })).toBeNull();
    expect(await service.deletePosting("ub", p.id)).toBe(false);
    expect((await service.listPostings("ub")).map((x) => x.id)).not.toContain(p.id);
    const [summary] = await service.listPostings("ua");
    expect(summary).toMatchObject({ id: p.id, hasJd: true });
    expect(summary).not.toHaveProperty("jdText");
  });

  it("같은 사용자의 같은 URL(정규화 기준)은 409 + 기존 id, 다른 사용자는 허용", async () => {
    const first = await service.createPosting("ua", input({ company: "A", roleTitle: "B", url: "https://www.wanted.co.kr/wd/777" }));
    const err = await service.createPosting("ua", input({ company: "A2", roleTitle: "B2", url: "https://wanted.co.kr/wd/777/?utm_source=x" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(service.DuplicatePostingError);
    expect(err).toBeInstanceOf(FeatureError);
    expect((err as InstanceType<typeof service.DuplicatePostingError>).status).toBe(409);
    expect((err as InstanceType<typeof service.DuplicatePostingError>).existingId).toBe(first.id);
    await expect(service.createPosting("ub", input({ company: "A", roleTitle: "B", url: "https://wanted.co.kr/wd/777" }))).resolves.toBeTruthy();

    const other = await service.createPosting("ua", input({ company: "C", roleTitle: "D", url: "https://wanted.co.kr/wd/778" }));
    await expect(service.updatePosting("ua", other.id, { url: "wanted.co.kr/wd/777" })).rejects.toMatchObject({ existingId: first.id });
    // URL 없는 공고는 여러 개 가능.
    await service.createPosting("ua", input({ company: "E", roleTitle: "F" }));
    await service.createPosting("ua", input({ company: "E", roleTitle: "F" }));
  });

  it("javascript: 같은 주소는 저장하지 않는다(링크 XSS 방지)", async () => {
    await expect(service.createPosting("ua", input({ company: "X", roleTitle: "Y", url: "javascript:alert(1)" }))).rejects.toMatchObject({ status: 400 });
  });

  it("수정: 마감일만 바꾸면 종류를 맞추고, 지우면 시각도 지운다. 어긋난 조합은 400", async () => {
    const p = await service.createPosting("ua", input({ company: "M", roleTitle: "N" }));
    expect(p.deadlineKind).toBe("unspecified");
    const withDate = await service.updatePosting("ua", p.id, { deadline: "2026-12-01", deadlineTime: "18:00" });
    expect(withDate).toMatchObject({ deadline: "2026-12-01", deadlineTime: "18:00", deadlineKind: "date" });
    const cleared = await service.updatePosting("ua", p.id, { deadline: "" });
    expect(cleared).toMatchObject({ deadline: "", deadlineTime: "", deadlineKind: "unspecified" });
    await expect(service.updatePosting("ua", p.id, { deadlineKind: "date" })).rejects.toMatchObject({ status: 400 });
    await expect(service.updatePosting("ua", p.id, { deadlineTime: "10:00" })).rejects.toMatchObject({ status: 400 });
    expect(await service.updatePosting("ua", p.id, { deadlineKind: "rolling", status: "planned" })).toMatchObject({ deadlineKind: "rolling", status: "planned" });
  });

  it("삭제하면 연결된 진단·이력서는 남고 postingId만 null", async () => {
    const p = await service.createPosting("ua", input({ company: "Del", roleTitle: "R" }));
    await db.insert(schema.diagnoses).values({
      id: "dg-del",
      userId: "ua",
      title: "t",
      targetRole: "R",
      situation: "general",
      resumeText: "r",
      model: "m",
      postingId: p.id,
    });
    expect((await service.listPostingLinks("ua", p.id)).diagnoses.map((d) => d.id)).toEqual(["dg-del"]);
    expect((await service.listPostingLinks("ub", p.id)).diagnoses).toEqual([]);
    expect(await service.deletePosting("ua", p.id)).toBe(true);
    const [row] = await db.select().from(schema.diagnoses).where((await import("drizzle-orm")).eq(schema.diagnoses.id, "dg-del"));
    expect(row?.postingId).toBeNull();
  });
});

describe("URL 가져오기 작업", () => {
  const fetchPage = vi.fn(async (url: string) => ({ url, html: PAGE_HTML }));

  it("작업을 만들고 한 번만 실행한다(동시 호출 2회 → LLM 1회), 완료되면 공고가 생긴다", async () => {
    const { job, reused } = await imports.createImport("ua", "https://jobs.example/pay/1");
    expect(reused).toBe(false);
    expect(job.status).toBe("queued");
    const llm = new FakeLlmClient({ delayMs: 30 });
    const spy = vi.spyOn(llm, "generate");
    await Promise.all([imports.runImport(job.id, { llm, fetchPage }), imports.runImport(job.id, { llm, fetchPage })]);
    expect(spy).toHaveBeenCalledTimes(1);
    const done = await imports.getImport("ua", job.id);
    expect(done).toMatchObject({ status: "completed", error: null });
    const posting = await service.getPosting("ua", done!.postingId!);
    expect(posting).toMatchObject({ company: "페이랩", roleTitle: "백엔드 개발자", deadline: "2026-11-20", deadlineTime: "18:00", extractedBy: "fake" });
    expect(posting!.jdText).toContain("Python과 SQL");
    // 끝난 작업은 다시 실행하지 않는다.
    await imports.runImport(job.id, { llm, fetchPage });
    expect(spy).toHaveBeenCalledTimes(1);
    // 남의 작업은 보이지 않는다.
    expect(await imports.getImport("ub", job.id)).toBeNull();
  });

  it("이미 보관한 URL은 작업을 만들지 않고 409 + 기존 id", async () => {
    const existing = await service.createPosting("ua", input({ company: "S", roleTitle: "T", url: "https://jobs.example/saved" }));
    await expect(imports.createImport("ua", "https://jobs.example/saved?utm_source=x")).rejects.toMatchObject({ status: 409, existingId: existing.id });
  });

  it("공개 http/https가 아닌 주소는 400", async () => {
    await expect(imports.createImport("ua", "file:///etc/passwd")).rejects.toMatchObject({ status: 400 });
  });

  it("같은 URL이 진행 중이면 그 작업을 돌려준다", async () => {
    const a = await imports.createImport("ub", "https://jobs.example/same");
    const b = await imports.createImport("ub", "https://jobs.example/same");
    expect(b).toMatchObject({ reused: true, job: { id: a.job.id } });
    // www·추적 파라미터·끝 슬래시만 다른 링크도 같은 작업으로 본다.
    const c = await imports.createImport("ub", "https://www.jobs.example/same/?utm_source=a");
    expect(c).toMatchObject({ reused: true, job: { id: a.job.id } });
  });

  it("실패 오류에 내부 내용을 담지 않는다", async () => {
    const { job } = await imports.createImport("ub", "https://jobs.example/broken");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await imports.runImport(job.id, {
      llm: new FakeLlmClient(),
      fetchPage: async () => {
        throw new Error("connect 10.0.0.5 INTERNAL_SECRET");
      },
    });
    errorSpy.mockRestore();
    const failed = await imports.getImport("ub", job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
    expect(failed?.error).not.toContain("INTERNAL_SECRET");
  });

  it("근거 검증 실패는 사용자용 문구로 남긴다", async () => {
    const { job } = await imports.createImport("ub", "https://jobs.example/nofacts");
    await imports.runImport(job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: `${PAGE_HTML}<p>[가짜:근거없음]</p>` }) });
    expect(await imports.getImport("ub", job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("회사와 모집 직무") });
  });

  it("시간 상한을 넘기면 시간 초과로 실패한다", async () => {
    const { job } = await imports.createImport("ub", "https://jobs.example/slow");
    await imports.runImport(job.id, {
      llm: new FakeLlmClient({ delayMs: 200 }),
      fetchPage: async (url) => ({ url, html: PAGE_HTML }),
      timeLimitMs: 20,
    });
    expect(await imports.getImport("ub", job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("시간이 초과") });
  });

  it("5분 넘게 멈춘 작업은 다시 실행하고, 시도를 다 쓰면 실패로 닫는다", async () => {
    const { eq } = await import("drizzle-orm");
    const { job } = await imports.createImport("ub", "https://jobs.example/stuck");
    const old = new Date(Date.now() - 6 * 60_000);
    await db.update(schema.postingImports).set({ status: "analyzing", attempts: 1, updatedAt: old }).where(eq(schema.postingImports.id, job.id));
    const stuck = await imports.getImport("ub", job.id);
    expect(imports.isImportStale(stuck!)).toBe(true);
    // 아직 멈추지 않은(최근 갱신) 진행 중 작업은 차지하지 않는다.
    const { job: fresh } = await imports.createImport("ub", "https://jobs.example/fresh");
    await db.update(schema.postingImports).set({ status: "reading", attempts: 1 }).where(eq(schema.postingImports.id, fresh.id));
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(fresh.id, { llm, fetchPage });
    expect(spy).not.toHaveBeenCalled();

    await imports.runImport(job.id, { llm, fetchPage });
    expect(await imports.getImport("ub", job.id)).toMatchObject({ status: "completed" });

    const { job: dead } = await imports.createImport("ub", "https://jobs.example/dead");
    await db.update(schema.postingImports).set({ status: "reading", attempts: imports.MAX_IMPORT_ATTEMPTS, updatedAt: old }).where(eq(schema.postingImports.id, dead.id));
    await imports.runImport(dead.id, { llm, fetchPage });
    expect(await imports.getImport("ub", dead.id)).toMatchObject({ status: "failed", error: expect.stringContaining("끊겼습니다") });
  });

  it("최근 24시간 20건을 넘으면 429(지운 공고와 무관하게 작업 행으로 센다)", async () => {
    await db.insert(schema.users).values({ id: "uc", email: "uc@x.com", passwordHash: "x" });
    const now = new Date();
    await db.insert(schema.postingImports).values(
      Array.from({ length: 20 }, (_, i) => ({ id: `lim-${i}`, userId: "uc", url: `https://jobs.example/l${i}`, status: "failed" as const, createdAt: now, updatedAt: now })),
    );
    await expect(imports.createImport("uc", "https://jobs.example/over")).rejects.toMatchObject({ status: 429 });
    expect((await imports.listRecentImports("uc")).length).toBe(10);
  });
});

describe("진단·이력서의 공고 연결", () => {
  it("parseDiagnosisForm: JD·직무를 비우면 공고의 것을 쓰고, 보낸 값은 존중한다", async () => {
    const { parseDiagnosisForm, requestedPostingId } = await import("@/lib/diagnoses/form");
    const form = new FormData();
    form.set("resumeText", "홍길동 백엔드 개발자. 결제 API 응답 시간 40% 단축. Python, SQL, AWS 운영 경험 5년.");
    form.set("postingId", " p-1 ");
    expect(requestedPostingId(form)).toBe("p-1");
    const posting = { jdText: "자격 요건\nPython 3년 이상, SQL 능숙, 대용량 트래픽 경험", roleTitle: "백엔드 개발자" };
    const { input: a } = await parseDiagnosisForm(form, { posting });
    expect(a).toMatchObject({ targetRole: "백엔드 개발자", jdText: posting.jdText });
    form.set("targetRole", "서버 개발자");
    form.set("jdText", "직접 붙여넣은 JD 본문입니다. 충분히 길게 씁니다. Kotlin, Spring");
    const { input: b } = await parseDiagnosisForm(form, { posting });
    expect(b).toMatchObject({ targetRole: "서버 개발자", jdText: "직접 붙여넣은 JD 본문입니다. 충분히 길게 씁니다. Kotlin, Spring" });
  });

  it("createDiagnosis가 postingId를 저장한다", async () => {
    const { createDiagnosis } = await import("@/lib/diagnoses/service");
    const p = await service.createPosting("ub", input({ company: "진단", roleTitle: "백엔드" }));
    const { id } = await createDiagnosis(
      "ub",
      { resumeText: "x".repeat(60), resumeFileName: null, targetRole: "백엔드", jdText: null, situation: "general", notes: null, postingId: p.id },
      "anthropic",
    );
    expect((await service.listPostingLinks("ub", p.id)).diagnoses.map((d) => d.id)).toEqual([id]);
  });

  it("이력서 기본값: 비운 회사·직무·JD만 공고 값으로 채우고 postingId를 붙인다", async () => {
    const { withResumePostingDefaults } = await import("./defaults");
    const posting = { id: "p9", company: "카카오", roleTitle: "백엔드", jdText: "JD 원문" };
    expect(withResumePostingDefaults({ company: "", roleTitle: "서버", templateId: "classic" }, posting)).toEqual({
      company: "카카오",
      roleTitle: "서버",
      jdText: "JD 원문",
      templateId: "classic",
      postingId: "p9",
    });
    expect(withResumePostingDefaults("x", posting)).toBe("x");
  });

  it("createResume이 postingId를 저장한다", async () => {
    process.env.STORAGE_DIR = path.join(dir, "storage");
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
    const { createResume } = await import("@/lib/resumes/service");
    const { emptyResumeDocument } = await import("@/lib/domain/resumes");
    const p = await service.createPosting("ub", input({ company: "이력서", roleTitle: "백엔드" }));
    const { resume } = await createResume("ub", {
      company: "이력서",
      roleTitle: "백엔드",
      templateId: "classic",
      document: emptyResumeDocument(),
      source: "manual",
      postingId: p.id,
    });
    expect((await service.listPostingLinks("ub", p.id)).resumes.map((r) => r.id)).toEqual([resume.id]);
  });
});
