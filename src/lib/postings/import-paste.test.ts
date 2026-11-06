/**
 * 봇 차단 사이트 가져오기(PGlite, 페이지·LLM은 가짜): 링크 가져오기가 code 'blocked'로 끝나 붙여넣기를 안내하고,
 * 본문 붙여넣어 가져오기가 URL 가져오기와 같은 경로(근거 검증·구조화·중복·하루 횟수)를 타되 링크 공용 공고로는 올리지 않는지.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTING_BLOCKED_ERROR } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let imports: typeof import("./imports");
let service: typeof import("./service");
let fetchMod: typeof import("./fetch");

const URL_A = "https://careers.example/recruit/10460";

/** 브라우저에서 Ctrl+A로 복사한 듯한 본문(메뉴·푸터 포함). */
const pasted = (role = "게임 서버 프로그래머") =>
  [
    "채용 홈  채용 공고  인재상  FAQ",
    "회사: 예시게임즈",
    `모집 직무: ${role}`,
    "근무지: 성남 판교",
    "접수 마감: 2026.12.20 23:59",
    "주요 업무",
    "- 대규모 온라인 게임 서버 개발",
    "자격 요건",
    "- C++ 또는 C# 서버 개발 경험 3년 이상",
    "우대 사항",
    "- 분산 시스템 운영 경험",
    "정규직으로 채용하며 수습 기간은 3개월입니다. ".repeat(4),
    "개인정보처리방침 | 이용약관 | © 예시게임즈",
  ].join("\r\n");

const CHALLENGE_HTML =
  '<html><head><title>NEXON</title></head><body><h2>접속을 위해 보안 검사를 진행해 주세요.</h2><noscript>Enable JavaScript and cookies to continue</noscript>' +
  "<script>window._cf_chl_opt={cType:'managed'};</script></body></html>";

beforeAll(async () => {
  tdb = await createTestDb();
  imports = await import("./imports");
  service = await import("./service");
  fetchMod = await import("./fetch");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

describe("링크 가져오기: 보안 검사 페이지", () => {
  it("Cloudflare 검사(403 cf-mitigated)는 실패 + errorCode 'blocked'(AI 호출 없음)", async () => {
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const r = await imports.createImport("ua", URL_A);
    await imports.runImport(r.job.id, {
      llm,
      fetchDeps: {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        connect: async () => ({
          status: 403,
          headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge", server: "cloudflare" },
          body: new TextEncoder().encode(CHALLENGE_HTML),
        }),
      },
    });
    const job = await imports.getImport("ua", r.job.id);
    expect(job).toMatchObject({ status: "failed", error: POSTING_BLOCKED_ERROR, errorCode: "blocked", postingId: null });
    expect(spy).not.toHaveBeenCalled();
    // 목록 조회에도 같은 code가 실린다(화면이 새로 열려도 붙여넣기를 안내).
    expect((await imports.listRecentImports("ua"))[0]).toMatchObject({ errorCode: "blocked" });
  });

  it("표식 없이 검사 문구만 남은 200 페이지는 AI가 '공고 아님'으로 답해도 차단 안내로 끝난다", async () => {
    const r = await imports.createImport("ua", URL_A);
    const html = `<h2>접속을 위해 보안 검사를 진행해 주세요.</h2><p>${"Checking your browser before accessing the site. ".repeat(4)}</p>`;
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html }) });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", errorCode: "blocked" });
  });

  it("보통의 실패는 errorCode가 없다", async () => {
    const r = await imports.createImport("ua", URL_A);
    await imports.runImport(r.job.id, {
      llm: new FakeLlmClient(),
      fetchPage: async () => {
        throw new fetchMod.PostingFetchError("공고 사이트에 연결하지 못했습니다.");
      },
    });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", errorCode: null });
  });
});

describe("본문 붙여넣어 가져오기", () => {
  it("페이지를 읽지 않고 붙여넣은 본문으로 같은 경로를 탄다: 근거 검증·구조화·출처 링크(링크 공용 공고로는 올리지 않는다)", async () => {
    const fetchPage = vi.fn(async (url: string) => ({ url, html: CHALLENGE_HTML }));
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const r = await imports.createImport("ua", `${URL_A}?utm_source=x`, { pasted: true });
    expect(r).toMatchObject({ reused: false, fromShared: false, job: { status: "queued", refresh: false, errorCode: null } });
    await imports.runImport(r.job.id, { llm, fetchPage, pastedText: pasted() });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].user).toContain("모집 직무: 게임 서버 프로그래머");
    expect(spy.mock.calls[0]![0].user).not.toContain("\r");

    const done = await imports.getImport("ua", r.job.id);
    expect(done).toMatchObject({ status: "completed", errorCode: null, sharedPostingId: null });
    const mine = await service.getPosting("ua", done!.postingId!);
    expect(mine).toMatchObject({
      company: "예시게임즈",
      roleTitle: "게임 서버 프로그래머",
      deadline: "2026-12-20",
      urlKey: "careers.example/recruit/10460",
    });
    expect(mine!.sourceText).toContain("대규모 온라인 게임 서버 개발");
    expect(mine!.structured?.source).toBe("llm");
    // 직접 입력 공고처럼 url 없는 공용 공고(공개 필드만)에 연결된다 — 붙여넣은 원문(sourceText)·링크는 공유하지 않는다.
    expect(await tdb.prisma.sharedPosting.count({ where: { urlKey: { not: null } } })).toBe(0);
    const s = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: mine!.sharedPostingId! } });
    expect(s).toMatchObject({ url: null, urlKey: null, sourceText: null, company: "예시게임즈" });

    // 다른 사용자의 링크 가져오기는 붙여넣은 본문을 받지 않는다(공고 찾기 바로 담기 없음 — 페이지를 직접 읽는다).
    const b = await imports.createImport("ub", URL_A);
    expect(b).toMatchObject({ fromShared: false, job: { status: "queued" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("공고 찾기에 같은 링크의 공고가 있으면 붙여넣기도 그것을 바로 담는다(AI 없음)", async () => {
    const first = await imports.createImport("ua", URL_A);
    await imports.runImport(first.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: `<pre>${pasted()}</pre>` }) });
    const shared = (await imports.getImport("ua", first.job.id))!.sharedPostingId!;
    expect(shared).toBeTruthy();
    const b = await imports.createImport("ub", URL_A, { pasted: true });
    expect(b).toMatchObject({ fromShared: true, job: { status: "completed", sharedPostingId: shared } });
  });

  it("이미 보관한 링크는 409 + existingId, 같은 링크를 진행 중이면 409(재사용하지 않는다)", async () => {
    const first = await imports.createImport("ua", URL_A, { pasted: true });
    await expect(imports.createImport("ua", URL_A, { pasted: true })).rejects.toMatchObject({ status: 409 });
    // 링크 가져오기는 진행 중 작업을 그대로 재사용한다(기존 동작).
    expect(await imports.createImport("ua", URL_A)).toMatchObject({ reused: true, job: { id: first.job.id } });
    await imports.runImport(first.job.id, { llm: new FakeLlmClient(), pastedText: pasted() });
    const postingId = (await imports.getImport("ua", first.job.id))!.postingId!;
    await expect(imports.createImport("ua", "careers.example/recruit/10460/", { pasted: true })).rejects.toMatchObject({
      status: 409,
      existingId: postingId,
    });
  });

  it("refresh는 붙여넣기에서 쓰지 않는다(보관한 공고가 있으면 409)", async () => {
    const r = await imports.createImport("ua", URL_A, { pasted: true });
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), pastedText: pasted() });
    await expect(imports.createImport("ua", URL_A, { pasted: true, refresh: true })).rejects.toMatchObject({ status: 409 });
  });

  it("붙여넣은 내용이 보안 검사 화면이면 다시 복사하라고 안내한다(차단 code 아님)", async () => {
    const r = await imports.createImport("ua", URL_A, { pasted: true });
    const text = `NEXON\n접속을 위해 보안 검사를 진행해 주세요.\nEnable JavaScript and cookies to continue\n${"보안 검사가 정상적으로 진행되지 않을 경우 1:1 문의를 이용해주시기 바랍니다. ".repeat(3)}`;
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), pastedText: text });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", error: imports.PASTED_CHALLENGE_ERROR, errorCode: null });
  });

  it("공고가 아닌 내용은 근거 검증에 걸려 실패한다", async () => {
    const r = await imports.createImport("ua", URL_A, { pasted: true });
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), pastedText: "오늘의 날씨와 뉴스 요약입니다. ".repeat(20) });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", postingId: null });
    expect(await tdb.prisma.jobPosting.count({ where: { userId: "ua" } })).toBe(0);
  });

  it("붙여넣기 가져오기 뒤에는 원문 캡처를 시도하지 않는다", async () => {
    const r = await imports.createImport("ua", URL_A, { pasted: true });
    const capture = vi.fn();
    await imports.runImportThenCapture(r.job.id, { llm: new FakeLlmClient(), pastedText: pasted(), capture: { capture } });
    const done = await imports.getImport("ua", r.job.id);
    expect(done?.status).toBe("completed");
    expect(capture).not.toHaveBeenCalled();
    expect(await tdb.prisma.sharedPosting.count({ where: { captureStatus: { not: null } } })).toBe(0);
  });
});

describe("원문만 붙여넣기(링크 없음, '직접 추가'의 AI 추가)", () => {
  it("링크 없이 작업을 만들고 같은 분석으로 공고를 만든다: 출처 링크·링크 공용 공고 없음, 원문은 내 공고에만", async () => {
    const fetchPage = vi.fn(async (url: string) => ({ url, html: CHALLENGE_HTML }));
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const r = await imports.createImport("ua", "  ", { pasted: true });
    expect(r).toMatchObject({ reused: false, fromShared: false, job: { url: "", status: "queued", refresh: false } });
    expect(await tdb.prisma.postingImport.findUniqueOrThrow({ where: { id: r.job.id } })).toMatchObject({ url: "", urlKey: null });

    await imports.runImport(r.job.id, { llm, fetchPage, pastedText: pasted() });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    const done = await imports.getImport("ua", r.job.id);
    expect(done).toMatchObject({ status: "completed", errorCode: null, sharedPostingId: null, error: null });
    const mine = await service.getPosting("ua", done!.postingId!);
    expect(mine).toMatchObject({ company: "예시게임즈", roleTitle: "게임 서버 프로그래머", deadline: "2026-12-20", url: "", urlKey: null, platform: "" });
    expect(mine!.sourceText).toContain("대규모 온라인 게임 서버 개발");
    expect(mine!.structured?.source).toBe("llm");
    expect(mine!.structured?.duties.length).toBeGreaterThan(0);
    expect(await tdb.prisma.jobPosting.findUniqueOrThrow({ where: { id: mine!.id } })).toMatchObject({ url: null, urlKey: null });
    // 공용 공고는 직접 입력처럼 공개 필드만(링크·원문 없음).
    const s = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: mine!.sharedPostingId! } });
    expect(s).toMatchObject({ url: null, urlKey: null, sourceText: null, company: "예시게임즈" });
    // 다른 사용자는 볼 수 없다.
    expect(await service.getPosting("ub", done!.postingId!)).toBeNull();
  });

  it("같은 본문을 연달아 붙여넣어도 진행 중 작업 재사용·링크 중복 409 없이 각각 작업을 만든다(동시 진행 제한은 같다)", async () => {
    const a = await imports.createImport("ua", "", { pasted: true });
    const b = await imports.createImport("ua", "", { pasted: true });
    expect(b.job.id).not.toBe(a.job.id);
    // 링크 가져오기는 링크 없는 작업과 섞이지 않는다.
    expect(await imports.createImport("ua", URL_A)).toMatchObject({ reused: false });
    await expect(imports.createImport("ua", "", { pasted: true })).rejects.toMatchObject({ status: 409 });
  });

  it("공고가 아닌 내용은 '공고 내용을 찾지 못했습니다' 안내로 실패한다(공고를 만들지 않는다)", async () => {
    const r = await imports.createImport("ua", "", { pasted: true });
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), pastedText: "오늘의 날씨와 뉴스 요약입니다. ".repeat(20) });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", error: imports.PASTED_NOT_POSTING_ERROR, postingId: null });
    expect(imports.PASTED_NOT_POSTING_ERROR).toContain("공고 내용을 찾지 못했습니다");
    expect(await tdb.prisma.jobPosting.count({ where: { userId: "ua" } })).toBe(0);
  });

  it("보안 검사 화면을 붙여넣으면 다시 복사하라고 안내한다", async () => {
    const r = await imports.createImport("ua", "", { pasted: true });
    const text = `NEXON\n접속을 위해 보안 검사를 진행해 주세요.\nEnable JavaScript and cookies to continue\n${"보안 검사가 정상적으로 진행되지 않을 경우 1:1 문의를 이용해주시기 바랍니다. ".repeat(3)}`;
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), pastedText: text });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", error: imports.PASTED_CHALLENGE_ERROR });
  });

  it("멈춘 작업이 본문 없이 다시 실행되면 링크를 읽지 않고 다시 붙여넣으라고 안내한다", async () => {
    const r = await imports.createImport("ua", "", { pasted: true });
    const fetchPage = vi.fn(async (url: string) => ({ url, html: "" }));
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(r.job.id, { llm, fetchPage });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", error: imports.TEXT_IMPORT_INTERRUPTED_ERROR });
  });

  it("원문 캡처를 시도하지 않는다", async () => {
    const r = await imports.createImport("ua", "", { pasted: true });
    const capture = vi.fn();
    await imports.runImportThenCapture(r.job.id, { llm: new FakeLlmClient(), pastedText: pasted(), capture: { capture } });
    expect((await imports.getImport("ua", r.job.id))?.status).toBe("completed");
    expect(capture).not.toHaveBeenCalled();
  });
});
