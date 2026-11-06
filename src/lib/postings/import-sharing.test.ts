/**
 * URL 가져오기 ↔ 공고 찾기(PGlite, 페이지·LLM은 가짜): 가져오기 결과가 공용 공고로 저장되고, 다른 사용자가 같은 URL을
 * 가져오면 LLM·페이지 읽기 없이 바로 담긴다(하루 횟수에 세지 않음). 다시 가져오기는 내 공고를 새 내용으로 맞춘다.
 * 공고 찾기 필터(회사·직무·기술·마감).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let imports: typeof import("./imports");
let shared: typeof import("./shared");
let service: typeof import("./service");
let structure: typeof import("./structure");

const page = (role = "백엔드 개발자", deadline = "2026.11.20 18:00") =>
  `<div>회사: 페이랩</div><div>모집 직무: ${role}</div><div>근무지: 서울</div><div>접수 마감: ${deadline}</div><p>${"정규직 백엔드 개발자를 채용합니다. Python과 SQL 경험이 필요합니다. ".repeat(5)}</p>`;

beforeAll(async () => {
  tdb = await createTestDb();
  imports = await import("./imports");
  shared = await import("./shared");
  service = await import("./service");
  structure = await import("./structure");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

describe("가져오기 → 공고 찾기", () => {
  it("가져온 공고는 공용 공고로도 저장되고, 다른 사용자는 AI 없이 바로 담는다", async () => {
    const fetchPage = vi.fn(async (url: string) => ({ url, html: page() }));
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const a = await imports.createImport("ua", "https://jobs.example/pay/1?utm_source=x");
    expect(a).toMatchObject({ reused: false, fromShared: false });
    await imports.runImport(a.job.id, { llm, fetchPage });
    const doneA = await imports.getImport("ua", a.job.id);
    expect(doneA).toMatchObject({ status: "completed" });
    expect(doneA!.sharedPostingId).toBeTruthy();
    const mineA = await service.getPosting("ua", doneA!.postingId!);
    expect(mineA).toMatchObject({ company: "페이랩", sharedPostingId: doneA!.sharedPostingId });
    const row = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: doneA!.sharedPostingId! } });
    expect(row).toMatchObject({ urlKey: "jobs.example/pay/1", company: "페이랩", importerCount: 1, createdBy: "ua" });
    expect(spy).toHaveBeenCalledTimes(1);

    // 다른 사용자: www·추적 파라미터만 다른 링크도 같은 공고 → 작업은 이미 completed, 페이지·LLM 호출 없음.
    const b = await imports.createImport("ub", "https://www.jobs.example/pay/1/");
    expect(b).toMatchObject({ reused: false, fromShared: true, job: { status: "completed", sharedPostingId: row.id } });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const mineB = await service.getPosting("ub", b.job.postingId!);
    expect(mineB).toMatchObject({ company: "페이랩", sharedPostingId: row.id, status: "saved", note: "" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: row.id } })).importerCount).toBe(2);

    // 이미 보관한 사용자가 다시 넣으면 409 + 기존 id(작업 없음).
    await expect(imports.createImport("ub", "https://jobs.example/pay/1")).rejects.toMatchObject({ status: 409, existingId: mineB!.id });
  });

  it("공고 찾기에서 바로 담은 작업은 하루 가져오기 횟수에 세지 않는다", async () => {
    const s = await shared.upsertSharedPosting({
      url: "https://jobs.example/cached",
      posting: PostingCreateInputSchema.parse({ company: "캐시", roleTitle: "PM", url: "https://jobs.example/cached" }),
      structure: null,
      sourceText: "",
      extractedBy: "fake",
      createdBy: "ua",
    });
    const at = new Date();
    // 실제 실행한 작업(attempts ≥ 1)을 많이 쌓아도 하루 제한은 없다.
    for (let i = 0; i < 25; i++) {
      await tdb.prisma.postingImport.create({
        data: { id: `old${i}`, userId: "ub", url: `https://jobs.example/old/${i}`, status: "failed", attempts: 1, createdAt: at, updatedAt: at },
      });
    }
    const r = await imports.createImport("ub", s.url!);
    expect(r.fromShared).toBe(true);
    const next = await imports.createImport("ub", "https://jobs.example/new");
    expect(next).toMatchObject({ fromShared: false, job: { status: "queued" } });
  });

  it("다시 가져오기: 공용 공고가 있어도 페이지를 다시 읽고, 내 공고를 새 내용으로 맞춘다(상태·메모 유지)", async () => {
    const llm = new FakeLlmClient();
    const first = await imports.createImport("ua", "https://jobs.example/r/1");
    await imports.runImport(first.job.id, { llm, fetchPage: async (url) => ({ url, html: page("백엔드 개발자") }) });
    const postingId = (await imports.getImport("ua", first.job.id))!.postingId!;
    await service.updatePosting("ua", postingId, { status: "applied", note: "내 메모" });

    const again = await imports.createImport("ua", "https://jobs.example/r/1", { refresh: true });
    expect(again).toMatchObject({ fromShared: false, reused: false, job: { status: "queued", refresh: true, postingId } });
    await imports.runImport(again.job.id, { llm, fetchPage: async (url) => ({ url, html: page("데이터 엔지니어", "2026.12.05") }) });
    const done = await imports.getImport("ua", again.job.id);
    expect(done).toMatchObject({ status: "completed", postingId, refresh: true });
    const p = await service.getPosting("ua", postingId);
    expect(p).toMatchObject({ roleTitle: "데이터 엔지니어", deadline: "2026-12-05", status: "applied", note: "내 메모" });
    expect(await tdb.prisma.jobPosting.count({ where: { userId: "ua" } })).toBe(1);
    const s = await tdb.prisma.sharedPosting.findFirstOrThrow({ where: { urlKey: "jobs.example/r/1" } });
    expect(s.roleTitle).toBe("데이터 엔지니어");
  });

  it("보관함에 없는 공고를 다시 가져오면 새로 만들고 공용 공고를 갱신한다", async () => {
    await shared.upsertSharedPosting({
      url: "https://jobs.example/r/2",
      posting: PostingCreateInputSchema.parse({ company: "옛 회사", roleTitle: "옛 직무", url: "https://jobs.example/r/2" }),
      structure: null,
      sourceText: "",
      extractedBy: "fake",
      createdBy: "ua",
    });
    const r = await imports.createImport("ub", "https://jobs.example/r/2", { refresh: true });
    expect(r).toMatchObject({ fromShared: false, job: { status: "queued", postingId: null } });
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: page() }) });
    const done = await imports.getImport("ub", r.job.id);
    expect(await service.getPosting("ub", done!.postingId!)).toMatchObject({ company: "페이랩" });
    expect(await tdb.prisma.sharedPosting.findFirstOrThrow({ where: { urlKey: "jobs.example/r/2" } })).toMatchObject({ company: "페이랩", importerCount: 1 });
  });

  it("숨긴 공용 공고는 재사용하지 않고 새로 가져온다", async () => {
    const s = await shared.upsertSharedPosting({
      url: "https://jobs.example/hidden",
      posting: PostingCreateInputSchema.parse({ company: "숨김", roleTitle: "R", url: "https://jobs.example/hidden" }),
      structure: null,
      sourceText: "",
      extractedBy: "fake",
      createdBy: "ua",
    });
    await shared.setSharedPostingHidden(s.id, true);
    const r = await imports.createImport("ub", "https://jobs.example/hidden");
    expect(r).toMatchObject({ fromShared: false, job: { status: "queued" } });
  });
});

describe("리다이렉트 링크(입력 주소 ≠ 최종 주소)", () => {
  const redirectTo = (finalUrl: string, html = page()) => vi.fn(async () => ({ url: finalUrl, html }));

  it("같은 단축 링크를 다른 사용자가 넣으면 별칭으로 공용 공고를 찾아 페이지·AI 없이 담고, 같은 사용자는 409", async () => {
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const fetchPage = redirectTo("https://jobs.example/real/1");
    const a = await imports.createImport("ua", "https://short.example/a");
    await imports.runImport(a.job.id, { llm, fetchPage });
    const doneA = (await imports.getImport("ua", a.job.id))!;
    expect(doneA).toMatchObject({ status: "completed" });

    const b = await imports.createImport("ub", "https://short.example/a");
    expect(b).toMatchObject({ fromShared: true, job: { status: "completed", sharedPostingId: doneA.sharedPostingId } });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(imports.createImport("ua", "https://short.example/a")).rejects.toMatchObject({ status: 409, existingId: doneA.postingId });
  });

  it("최종 주소가 공고 찾기에 이미 있으면 AI 분석 없이 담는다", async () => {
    const s = await shared.upsertSharedPosting({
      url: "https://jobs.example/real/2",
      posting: PostingCreateInputSchema.parse({ company: "기존", roleTitle: "R", url: "https://jobs.example/real/2" }),
      structure: null,
      sourceText: "",
      extractedBy: "fake",
      createdBy: "ua",
    });
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const r = await imports.createImport("ub", "https://short.example/b");
    expect(r).toMatchObject({ fromShared: false, job: { status: "queued" } });
    await imports.runImport(r.job.id, { llm, fetchPage: redirectTo("https://jobs.example/real/2") });
    const done = (await imports.getImport("ub", r.job.id))!;
    expect(done).toMatchObject({ status: "completed", sharedPostingId: s.id });
    expect(await service.getPosting("ub", done.postingId!)).toMatchObject({ company: "기존", sharedPostingId: s.id });
    expect(spy).not.toHaveBeenCalled();
  });

  it("최종 주소가 이미 내 보관함에 있으면 AI 분석 전에 기존 공고로 안내한다", async () => {
    const mine = await service.createPosting("ua", PostingCreateInputSchema.parse({ company: "직접", roleTitle: "R", url: "https://jobs.example/m/1" }));
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const r = await imports.createImport("ua", "https://short.example/c");
    await imports.runImport(r.job.id, { llm, fetchPage: redirectTo("https://jobs.example/m/1") });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", postingId: mine.id });
    expect(spy).not.toHaveBeenCalled();
  });

  it("다시 가져오기를 단축 링크로 열어도 내 공고를 갱신한다(두 번째 사본을 만들지 않는다)", async () => {
    const llm = new FakeLlmClient();
    const first = await imports.createImport("ua", "https://short.example/d");
    await imports.runImport(first.job.id, { llm, fetchPage: redirectTo("https://jobs.example/real/4", page("백엔드 개발자")) });
    const postingId = (await imports.getImport("ua", first.job.id))!.postingId!;
    const again = await imports.createImport("ua", "https://short.example/d", { refresh: true });
    expect(again.job.postingId).toBe(postingId);
    await imports.runImport(again.job.id, { llm, fetchPage: redirectTo("https://jobs.example/real/4", page("데이터 엔지니어")) });
    expect(await imports.getImport("ua", again.job.id)).toMatchObject({ status: "completed", postingId });
    expect(await tdb.prisma.jobPosting.count({ where: { userId: "ua" } })).toBe(1);
  });
});

describe("담은 사용자 수", () => {
  it("보관함 공고를 지우면 다시 센다", async () => {
    const a = await imports.createImport("ua", "https://jobs.example/cnt/1");
    await imports.runImport(a.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: page() }) });
    const b = await imports.createImport("ub", "https://jobs.example/cnt/1");
    const sid = b.job.sharedPostingId!;
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).importerCount).toBe(2);
    expect(await service.deletePosting("ub", b.job.postingId!)).toBe(true);
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).importerCount).toBe(1);
  });
});

describe("숨긴 공고(관리자)", () => {
  it("기본 목록·상세에서는 빠지고, hidden=only·includeHidden으로 보고 다시 공개할 수 있다", async () => {
    const s = await shared.upsertSharedPosting({
      url: "https://jobs.example/h/1",
      posting: PostingCreateInputSchema.parse({ company: "숨김", roleTitle: "R", url: "https://jobs.example/h/1" }),
      structure: null,
      sourceText: "",
      extractedBy: "fake",
      createdBy: "ua",
    });
    await shared.setSharedPostingHidden(s.id, true);
    expect((await shared.listSharedPostings({})).items.map((i) => i.id)).not.toContain(s.id);
    expect(await shared.getSharedPosting(s.id)).toBeNull();
    expect(await shared.isSharedPostingVisible(s.id)).toBe(false);
    const hiddenList = await shared.listSharedPostings({ hidden: "only" });
    expect(hiddenList.items).toEqual([expect.objectContaining({ id: s.id, hidden: true })]);
    expect(await shared.getSharedPosting(s.id, undefined, { includeHidden: true })).toMatchObject({ id: s.id, hidden: true });
    await shared.setSharedPostingHidden(s.id, false);
    expect(await shared.getSharedPosting(s.id)).toMatchObject({ id: s.id });
    expect((await shared.listSharedPostings({ hidden: "only" })).items).toEqual([]);
  });
});

describe("공고 찾기 필터", () => {
  const seed = (url: string, over: Record<string, unknown>, tech: string[] = []) => {
    const posting = PostingCreateInputSchema.parse({ company: "회사", roleTitle: "직무", url, jdText: "본문", ...over });
    const st = structure.structureFromText("주요 업무\n- 개발");
    return shared.upsertSharedPosting({
      url,
      posting,
      structure: st ? { ...st, techStack: tech } : null,
      sourceText: "",
      extractedBy: "fake",
      createdBy: "ua",
    });
  };
  const NOW = Date.parse("2026-11-06T03:00:00Z");

  it("회사·직무·기술·마감(마감 전·7일 이내)", async () => {
    await seed("https://a.example/1", { company: "토스", roleTitle: "백엔드 개발자", deadline: "2026-11-10" }, ["Kotlin", "Spring"]);
    await seed("https://a.example/2", { company: "당근", roleTitle: "iOS 개발자", deadline: "2026-12-31", jdText: "Swift와 React Native" }, ["Swift"]);
    await seed("https://a.example/3", { company: "토스뱅크", roleTitle: "PM", deadline: "2026-11-01" });
    await seed("https://a.example/4", { company: "라인", roleTitle: "데이터 엔지니어", deadlineKind: "rolling" });

    const names = async (o: Parameters<typeof shared.listSharedPostings>[0]) =>
      (await shared.listSharedPostings({ now: NOW, ...o })).items.map((i) => i.company).sort();
    expect(await names({ company: "토스" })).toEqual(["토스", "토스뱅크"]);
    expect(await names({ role: "개발자" })).toEqual(["당근", "토스"]);
    expect(await names({ tech: "Kotlin" })).toEqual(["토스"]);
    // 기술 칩에 없어도 본문에 있으면 걸린다(대소문자 무시).
    expect(await names({ tech: "react" })).toEqual(["당근"]);
    expect(await names({ deadline: "open" })).toEqual(["당근", "라인", "토스"]);
    expect(await names({ deadline: "soon" })).toEqual(["토스"]);
    expect(await names({ deadline: "all" })).toEqual(["당근", "라인", "토스", "토스뱅크"]);
    expect(await names({ company: "토스", deadline: "open" })).toEqual(["토스"]);
  });
});
