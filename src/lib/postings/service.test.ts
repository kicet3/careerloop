/**
 * 공고 저장소·가져오기 작업(PGlite 테스트 DB, 페이지 가져오기·LLM은 가짜): 소유권, 중복 URL 409,
 * 마감 합치기, 가져오기 동시 실행 1회·안전한 오류·멈춘 작업 재실행, 진단·이력서의 공고 연결.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-postings-"));
let tdb: TestDb;
let service: typeof import("./service");
let imports: typeof import("./imports");
let FeatureError: typeof import("@/lib/api/errors").FeatureError;

const input = (v: Record<string, unknown>) => PostingCreateInputSchema.parse(v);
const PAGE_HTML = `<div>회사: 페이랩</div><div>모집 직무: 백엔드 개발자</div><div>근무지: 서울</div><div>접수 마감: 2026.11.20 18:00</div><p>${"정규직 백엔드 개발자를 채용합니다. Python과 SQL 경험이 필요합니다. ".repeat(5)}</p>`;

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  service = await import("./service");
  imports = await import("./imports");
  ({ FeatureError } = await import("@/lib/api/errors"));
});

afterAll(() => tdb.close());

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
    await tdb.prisma.diagnosis.create({
      data: { id: "dg-del", userId: "ua", title: "t", targetRole: "R", situation: "general", resumeText: "r", model: "m", postingId: p.id },
    });
    expect((await service.listPostingLinks("ua", p.id)).diagnoses.map((d) => d.id)).toEqual(["dg-del"]);
    expect((await service.listPostingLinks("ub", p.id)).diagnoses).toEqual([]);
    expect(await service.deletePosting("ua", p.id)).toBe(true);
    const row = await tdb.prisma.diagnosis.findUnique({ where: { id: "dg-del" } });
    expect(row?.postingId).toBeNull();
  });
});

const JD = ["주요 업무", "- 결제 API 개발", "자격 요건", "- Python 3년 이상", "- SQL 경험", "우대 사항", "- Kafka 경험", "근무 조건", "연봉: 6,000만원 이상"].join("\n");

describe("구조화 공고", () => {
  it("직접 추가는 jdText를 정규식으로 구조화해 저장하고, 읽을 때 그대로 돌려준다", async () => {
    const p = await service.createPosting("ua", input({ company: "구조", roleTitle: "백엔드", jdText: JD }));
    expect(p.structured).toMatchObject({ source: "regex", requirements: ["Python 3년 이상", "SQL 경험"], preferred: ["Kafka 경험"], duties: ["결제 API 개발"] });
    expect(p.structured!.conditions.salary).toBe("6,000만원 이상");
    expect(p.sourceText).toBe("");
    const row = await tdb.prisma.jobPosting.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.structuredVersion).toBe(1);
    expect(await service.getPosting("ua", p.id)).toMatchObject({ structured: p.structured });
  });

  it("목록: 구조에서 기술·연봉 칩만 잘라 싣는다(구조 전체·원문은 싣지 않는다)", async () => {
    const p = await service.createPosting("ua", input({ company: "칩", roleTitle: "백엔드", jdText: JD }));
    const summary = (await service.listPostings("ua")).find((x) => x.id === p.id)!;
    expect(summary.highlights).toEqual({ techStack: expect.arrayContaining(["Python", "SQL", "Kafka"]), salary: "6,000만원 이상" });
    expect(summary).not.toHaveProperty("structured");
    expect(summary).not.toHaveProperty("sourceText");
  });

  it("저장된 구조가 깨졌거나 버전이 다르면 버리고, jdText가 있으면 즉석 정규식 구조를 돌려준다", async () => {
    expect(service.parseStoredStructure({ version: 99 })).toBeNull();
    expect(service.parseStoredStructure("깨짐")).toBeNull();
    const p = await service.createPosting("ua", input({ company: "깨짐", roleTitle: "백엔드", jdText: JD }));
    await tdb.prisma.jobPosting.update({ where: { id: p.id }, data: { structured: { ...p.structured, version: 2 } } });
    expect((await service.getPosting("ua", p.id))!.structured).toMatchObject({ source: "regex", requirements: ["Python 3년 이상", "SQL 경험"] });
    // 구조 없는 기존 행(지연 백필): null이면 즉석 계산, jdText도 없으면 null.
    const empty = await service.createPosting("ua", input({ company: "빈", roleTitle: "백엔드" }));
    expect(empty.structured).toBeNull();
    await tdb.prisma.jobPosting.update({ where: { id: empty.id }, data: { jdText: JD } });
    expect((await service.getPosting("ua", empty.id))!.structured?.source).toBe("regex");
  });

  it("PATCH: jdText를 바꾸면 정규식 구조를 다시 만들고, 구역 편집은 source 'user'(조합 상태면 jdText도 다시 조합)", async () => {
    const p = await service.createPosting("ua", input({ company: "수정", roleTitle: "백엔드", jdText: JD }));
    const changed = await service.updatePosting("ua", p.id, { jdText: `${JD}\n복리후생\n- 점심 식대` });
    expect(changed!.structured).toMatchObject({ source: "regex", benefits: ["점심 식대"] });

    const { version, source, jdComposed, sourceHash, extractedAt, ...edit } = changed!.structured!;
    void [version, source, jdComposed, sourceHash, extractedAt];
    const edited = await service.updatePosting("ua", p.id, { structured: { ...edit, benefits: ["점심 식대", "도서 구입비"] } });
    expect(edited!.structured).toMatchObject({ source: "user", jdComposed: false, benefits: ["점심 식대", "도서 구입비"] });
    // 직접 입력 JD(조합 안 됨)는 사용자 글이라 덮어쓰지 않는다.
    expect(edited!.jdText).toBe(changed!.jdText);

    // URL 가져오기처럼 jdText가 구조로 조합된 공고: 편집하면 jdText도 다시 조합한다.
    const composed = { ...edited!.structured!, source: "llm" as const, jdComposed: true };
    await tdb.prisma.jobPosting.update({ where: { id: p.id }, data: { structured: composed, sourceText: JD } });
    const recomposed = await service.updatePosting("ua", p.id, { structured: { ...edit, requirements: ["Go 5년 이상"] } });
    expect(recomposed!.structured).toMatchObject({ source: "user", jdComposed: true });
    expect(recomposed!.jdText).toContain("자격 요건\n- Go 5년 이상");
    // 조합된 상태에서 jdText를 직접 고치면 구조는 두고 조합만 끈다.
    const manual = await service.updatePosting("ua", p.id, { jdText: "직접 고친 JD" });
    expect(manual!.structured).toMatchObject({ source: "user", jdComposed: false });
    expect(manual!.jdText).toBe("직접 고친 JD");
    const { isStructureStale } = await import("./structure");
    expect(isStructureStale(manual!)).toBe(true);
    // 바뀐 원문에 맞춰 구역을 고쳐 저장하면 '원문이 바뀌었습니다' 안내가 사라진다.
    const fixed = await service.updatePosting("ua", p.id, { structured: { ...edit, requirements: ["Rust 3년 이상"] } });
    expect(fixed!.structured).toMatchObject({ source: "user", jdComposed: false });
    expect(fixed!.jdText).toBe("직접 고친 JD");
    expect(isStructureStale(fixed!)).toBe(false);
  });

  it("setPostingStructure: 원문 기준 다시 정리면 jdText를 조합하고, 얇으면 조합하지 않는다", async () => {
    const { structureFromText } = await import("./structure");
    const p = await service.createPosting("ua", input({ company: "다시", roleTitle: "백엔드", jdText: JD }));
    const rich = { ...structureFromText(JD), source: "llm" as const };
    const saved = await service.setPostingStructure("ua", p.id, rich, { composeJd: true });
    expect(saved!.structured).toMatchObject({ source: "llm", jdComposed: true });
    expect(saved!.jdText.startsWith("주요 업무\n- 결제 API 개발\n\n자격 요건")).toBe(true);
    const thin = { ...structureFromText("짧은 본문"), source: "llm" as const };
    const kept = await service.setPostingStructure("ua", p.id, thin, { composeJd: true, rawText: JD });
    expect(kept!.structured!.jdComposed).toBe(false);
    expect(kept!.jdText).toBe(JD);
    expect(await service.setPostingStructure("ub", p.id, rich, { composeJd: true })).toBeNull();
  });
});

describe("공고 삭제와 FK", () => {
  it("공고를 지우면 연결된 진단·이력서·지원·가져오기는 남고 postingId만 null(ON DELETE SET NULL)", async () => {
    const p = await service.createPosting("ua", input({ company: "FK", roleTitle: "R" }));
    await tdb.prisma.diagnosis.create({
      data: { id: "dg-fk", userId: "ua", title: "t", targetRole: "R", situation: "general", resumeText: "r", model: "m", postingId: p.id },
    });
    await tdb.prisma.companyResume.create({
      data: { id: "rs-fk", userId: "ua", company: "FK", roleTitle: "R", templateId: "performance", title: "t", postingId: p.id },
    });
    await tdb.prisma.application.create({ data: { id: "ap-fk", userId: "ua", company: "FK", roleTitle: "R", postingId: p.id } });
    await tdb.prisma.postingImport.create({ data: { id: "im-fk", userId: "ua", url: "https://x.example/1", status: "completed", postingId: p.id } });
    expect(await service.deletePosting("ua", p.id)).toBe(true);
    expect((await tdb.prisma.diagnosis.findUnique({ where: { id: "dg-fk" } }))?.postingId).toBeNull();
    expect((await tdb.prisma.companyResume.findUnique({ where: { id: "rs-fk" } }))?.postingId).toBeNull();
    expect((await tdb.prisma.application.findUnique({ where: { id: "ap-fk" } }))?.postingId).toBeNull();
    expect((await tdb.prisma.postingImport.findUnique({ where: { id: "im-fk" } }))?.postingId).toBeNull();
  });

  it("NUL 문자가 섞인 입력도 저장한다(Postgres text는 NUL을 받지 않으므로 지운다)", async () => {
    const p = await service.createPosting("ua", input({ company: "N\u0000UL", roleTitle: "R", jdText: "a\u0000b" }));
    expect(p).toMatchObject({ company: "NUL", jdText: "ab" });
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
    // 원문은 sourceText에, 구조는 AI 출처로 저장된다(이 본문은 구역 제목이 없어 얇다 → jdText도 원문).
    expect(posting!.sourceText).toContain("Python과 SQL");
    expect(posting!.structured).toMatchObject({ source: "llm", jdComposed: false });
    expect(posting!.note).toBe("");
    // 완료 알림은 한 번만(동시 실행 2회여도).
    const notes = await tdb.prisma.notification.findMany({ where: { userId: "ua", kind: "posting-import-completed" } });
    expect(notes).toEqual([expect.objectContaining({ body: "페이랩 · 백엔드 개발자", link: `/app/postings/${done!.postingId}` })]);
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
    const note = await tdb.prisma.notification.findFirst({ where: { userId: "ub", kind: "posting-import-failed" } });
    expect(note?.body).toContain("jobs.example");
    expect(note?.body).not.toContain("INTERNAL_SECRET");
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
    const { job } = await imports.createImport("ub", "https://jobs.example/stuck");
    const old = new Date(Date.now() - 6 * 60_000);
    await tdb.prisma.postingImport.update({ where: { id: job.id }, data: { status: "analyzing", attempts: 1, updatedAt: old } });
    const stuck = await imports.getImport("ub", job.id);
    expect(imports.isImportStale(stuck!)).toBe(true);
    // 아직 멈추지 않은(최근 갱신) 진행 중 작업은 차지하지 않는다.
    const { job: fresh } = await imports.createImport("ub", "https://jobs.example/fresh");
    await tdb.prisma.postingImport.update({ where: { id: fresh.id }, data: { status: "reading", attempts: 1 } });
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(fresh.id, { llm, fetchPage });
    expect(spy).not.toHaveBeenCalled();

    await imports.runImport(job.id, { llm, fetchPage });
    expect(await imports.getImport("ub", job.id)).toMatchObject({ status: "completed" });

    const { job: dead } = await imports.createImport("ub", "https://jobs.example/dead");
    await tdb.prisma.postingImport.update({ where: { id: dead.id }, data: { status: "reading", attempts: imports.MAX_IMPORT_ATTEMPTS, updatedAt: old } });
    await imports.runImport(dead.id, { llm, fetchPage });
    expect(await imports.getImport("ub", dead.id)).toMatchObject({ status: "failed", error: expect.stringContaining("끊겼습니다") });
  });

  it("하루 횟수 제한이 없다: 최근 24시간 20건이 넘어도 새로 가져온다", async () => {
    await tdb.prisma.user.create({ data: { id: "uc", email: "uc@x.com", passwordHash: "x" } });
    const now = new Date();
    await tdb.prisma.postingImport.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ id: `lim-${i}`, userId: "uc", url: `https://jobs.example/l${i}`, status: "failed", createdAt: now, updatedAt: now })),
    });
    await expect(imports.createImport("uc", "https://jobs.example/over")).resolves.toMatchObject({ job: { status: "queued" } });
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
