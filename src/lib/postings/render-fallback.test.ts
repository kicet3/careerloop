/**
 * 브라우저로 열어 읽기(자바스크립트로 그리는 공고 페이지): 정적 HTML이 빈 껍데기인지 판별(needsRendering — 실제 Smilegate 정적 응답
 * 픽스처), 그린 페이지 → 본문 텍스트(renderedPageText), 가져오기 작업의 대체 경로(PGlite, 페이지·브라우저·LLM은 가짜 주입).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTING_BLOCKED_ERROR } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const { needsRendering, renderedPageText, jsonEvidenceLines, pageMeta, isRenderedChallenge, THIN_PAGE_TEXT_CHARS } = await import("./rendered-text");
const { postingPageText } = await import("./page-text");
const { PostingRenderError, RENDER_GENERIC_ERROR, RENDER_TIMEOUT_ERROR, siteOf, isCollectableDataResponse, createDataCollector } = await import("./render");

const SMILEGATE_HTML = readFileSync(path.join(import.meta.dirname, "__fixtures__/smilegate-announce-6217.html"), "utf8");
const SMILEGATE_URL = "https://careers.smilegate.com/apply/announce/view?seq=6217";

/** 정적으로도 본문이 다 있는 보통 공고 페이지. */
const STATIC_POSTING_HTML = `<html><head><title>백엔드 개발자 채용</title></head><body>
<h1>백엔드 개발자</h1><p>회사: 페이랩</p><p>직무: 백엔드 개발자</p><p>접수 마감: 2026.11.20 18:00</p>
<h3>주요 업무</h3><ul><li>결제 API 설계와 운영</li><li>Python과 SQL로 데이터 파이프라인 개발</li></ul>
<h3>자격 요건</h3><ul><li>서버 개발 경력 3년 이상</li></ul>
<p>${"정규직으로 채용하며 수습 기간은 3개월입니다. ".repeat(50)}</p>
</body></html>`;

/** 브라우저가 그린 Smilegate 상세(본문 일부를 줄인 것 — 실제 화면 구성을 흉내). */
const RENDERED_TEXT = [
  "채용공고  인재풀 등록  FAQ",
  "[퍼블리싱/플랫폼]",
  "회원/게임 BE API 개발",
  "회사: 스마일게이트(사업부문)",
  "직무: 회원/게임 BE API 개발",
  "경력 · 정규직",
  "접수 마감: 2026.12.31 23:59",
  "담당업무",
  "- 회원 인증·게임 연동 API 설계와 개발",
  "자격요건",
  "- Java/Spring 기반 서버 개발 경력 3년 이상",
  "우대사항",
  "- 대규모 트래픽 서비스 운영 경험",
].join("\n");

const renderedSmilegate = (over: Partial<Awaited<ReturnType<import("./render").RenderPageFn>>> = {}) => ({
  url: SMILEGATE_URL,
  status: 200,
  headers: { "content-type": "text/html;charset=UTF-8", server: "AkamaiGHost" },
  html: SMILEGATE_HTML,
  text: RENDERED_TEXT,
  data: [{ data: { announceSeq: 6217, title: "회원/게임 BE API 개발", contents: "<p>근무지: 경기 성남시 분당구 판교</p><p>채용 시 마감될 수 있습니다.</p>", useYn: "Y" } }],
  ...over,
});

describe("needsRendering(정적 HTML이 자바스크립트로 그려지는 빈 껍데기인지)", () => {
  it("Smilegate 정적 응답(Knockout data-bind, 공고 본문 없음)은 브라우저로 연다", () => {
    const text = postingPageText(SMILEGATE_HTML);
    expect(text.length).toBeLessThan(THIN_PAGE_TEXT_CHARS);
    expect(text).not.toContain("BE API 개발");
    expect(needsRendering(SMILEGATE_HTML, text)).toBe(true);
  });

  it("본문이 충분한 정적 공고·JobPosting JSON-LD가 있는 페이지는 열지 않는다", () => {
    expect(needsRendering(STATIC_POSTING_HTML, postingPageText(STATIC_POSTING_HTML))).toBe(false);
    const ld = `<script type="application/ld+json">{"@type":"JobPosting","title":"x"}</script><div id="root"></div>`;
    expect(needsRendering(ld, "직무: x")).toBe(false);
    // 표식이 있어도 본문이 길면 열지 않는다(AI가 공고 아님으로 답하면 그때 연다).
    const long = `<div data-bind="text: x"></div><p>${"공고 내용 ".repeat(400)}</p>`;
    expect(needsRendering(long, postingPageText(long))).toBe(false);
  });

  it("빈 앱 루트·자바스크립트 필요 안내·불러오는 중 표시·아주 짧은 본문", () => {
    const filler = "채용 홈 회사 소개 인재상 복리후생 자주 묻는 질문 고객센터 개인정보처리방침 ".repeat(4);
    const shell = (body: string) => `<html><body><header>${filler}</header>${body}</body></html>`;
    for (const html of [
      shell('<div id="root"></div>'),
      shell('<div id="__next"> </div>'),
      shell("<app-root></app-root>"),
      shell("<noscript>You need to enable JavaScript to run this app.</noscript>"),
      shell("<noscript>이 페이지는 자바스크립트를 사용해야 합니다.</noscript>"),
      shell("<p>Loading...</p>"),
      shell("<p>{{ job.title }}</p>"),
    ]) {
      const text = postingPageText(html);
      expect(text.length).toBeGreaterThanOrEqual(150);
      expect(needsRendering(html, text), html.slice(-80)).toBe(true);
    }
    expect(needsRendering("<p>짧음</p>", "짧음")).toBe(true);
    expect(needsRendering(shell("<p>그냥 짧은 소개 페이지</p>"), postingPageText(shell("<p>그냥 짧은 소개 페이지</p>")))).toBe(false);
  });
});

describe("renderedPageText(그린 페이지 → 본문 텍스트)", () => {
  it("제목·공유 메타를 맨 앞에, 보이는 본문, 화면에 없는 JSON 값을 '페이지가 불러온 데이터'로 붙인다", () => {
    expect(pageMeta(SMILEGATE_HTML)).toMatchObject({ title: "Smilegate Careers", ogTitle: "스마일게이트(사업부문) 채용", ogDescription: "[퍼블리싱/플랫폼] 회원/게임 BE API 개발" });
    const text = renderedPageText(renderedSmilegate());
    expect(text.startsWith("페이지 제목: Smilegate Careers\n공유 제목: 스마일게이트(사업부문) 채용\n공유 설명: [퍼블리싱/플랫폼] 회원/게임 BE API 개발")).toBe(true);
    expect(text).toContain("자격요건\n- Java/Spring 기반 서버 개발 경력 3년 이상");
    expect(text).toContain("페이지가 불러온 데이터\ncontents: 근무지: 경기 성남시 분당구 판교");
    // 코드 값(Y)·숫자는 근거로 넣지 않는다. 화면에 이미 있는 짧은 값도 같은 값은 한 번만.
    expect(text).not.toContain("useYn");
    expect(text).not.toContain("6217");
  });

  it("JSON 값: HTML은 텍스트로, 화면에 이미 보이는 긴 값은 빼고, 글자 수 상한을 지킨다", () => {
    const visible = "회원 인증·게임 연동 API 설계와 개발을 맡습니다";
    const lines = jsonEvidenceLines(
      [
        {
          a: visible,
          b: "<ul><li>우대: Kotlin 경험</li></ul>",
          c: "https://x.example/a.png",
          d: "2026-12-31",
          e: "ABC_123",
          f: ["Remote friendly team", "x"],
          // 엔티티로 감싼 HTML(Smilegate 상세 API의 description)은 풀어서 읽고, 줄이 모두 화면에 있으면 뺀다.
          g: "&lt;table&gt;&lt;tr&gt;&lt;td&gt;복리후생 안내&amp;nbsp;&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;- 사내 식당 무료&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;",
          h: "<p>- 제출 서류가 있을 경우 PDF로 제출</p><p>- 수습 기간은 3개월입니다</p>",
        },
      ],
      `머리말 ${visible} 꼬리말\n- 제출 서류가 있을 경우 PDF로 제출\n- 수습 기간은 3개월입니다`,
    );
    expect(lines).toEqual(["b: 우대: Kotlin 경험", "d: 2026-12-31", "f: Remote friendly team", "g: 복리후생 안내\n- 사내 식당 무료"]);
    const many = jsonEvidenceLines([Array.from({ length: 5000 }, (_, i) => ({ t: `항목 ${i} 설명 문장` }))], "");
    expect(many.join("\n").length).toBeLessThanOrEqual(12_000);
  });

  it("보안 검사 화면 판별: 헤더·표식(fetch.ts와 같은 규칙) 또는 짧은 본문의 검사 문구", () => {
    expect(isRenderedChallenge({ status: 403, headers: { "cf-mitigated": "challenge" }, html: "", text: "" })).toBe(true);
    expect(isRenderedChallenge({ status: 200, headers: {}, html: "<html></html>", text: "접속을 위해 보안 검사를 진행해 주세요." })).toBe(true);
    expect(isRenderedChallenge({ status: 200, headers: {}, html: SMILEGATE_HTML, text: RENDERED_TEXT })).toBe(false);
  });

  it("siteOf: 같은 사이트 JSON 응답만 모으는 기준", () => {
    expect(siteOf("careers.smilegate.com")).toBe("smilegate.com");
    expect(siteOf("api.recruit.example.co.kr")).toBe("example.co.kr");
    expect(siteOf("example.com")).toBe("example.com");
  });

  it("JSON 응답 거름: XHR/fetch·2xx·같은 사이트·JSON·선언 크기", () => {
    const site = "smilegate.com";
    const ok = { requestId: "1", type: "XHR", status: 200, url: "https://careers.smilegate.com/api/apply/announce/6217", mimeType: "application/json" };
    expect(isCollectableDataResponse(ok, site)).toBe(true);
    expect(isCollectableDataResponse({ ...ok, type: "Fetch", mimeType: "text/plain", headers: { "Content-Type": "application/json; charset=utf-8" } }, site)).toBe(true);
    expect(isCollectableDataResponse({ ...ok, type: "Document" }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, type: "Script" }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, status: 401 }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, status: 302 }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, url: "https://tracker.example.com/collect" }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, url: "not a url" }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, mimeType: "text/html" }, site)).toBe(false);
    expect(isCollectableDataResponse({ ...ok, headers: { "content-length": String(600 * 1024) } }, site)).toBe(false);
  });

  it("JSON 응답 모으기: 받은 크기(압축 푼 바이트)가 상한을 넘으면 본문을 가져오지 않는다, 개수·합계 상한", async () => {
    const limits = { maxDataResponses: 2, maxDataResponseBytes: 100, maxDataBytes: 150 };
    const c = createDataCollector("example.com", limits);
    const meta = (id: string) => ({ requestId: id, type: "XHR", status: 200, url: `https://api.example.com/${id}`, mimeType: "application/json" });
    const body = (v: unknown) => vi.fn(async () => ({ body: JSON.stringify(v), base64Encoded: false }));

    // content-length 없는(chunked·gzip) 큰 응답: dataReceived로 센 크기가 넘으면 버린다.
    c.onResponse(meta("big"));
    c.onData("big", 60);
    c.onData("big", 60);
    const bigBody = body({ x: 1 });
    c.onFinished("big", bigBody);
    expect(bigBody).not.toHaveBeenCalled();

    // 다른 사이트·모르는 요청은 가져오지 않는다.
    c.onResponse({ ...meta("other"), url: "https://other.com/x" });
    const otherBody = body({});
    c.onFinished("other", otherBody);
    c.onFinished("unknown", otherBody);
    expect(otherBody).not.toHaveBeenCalled();

    // 실패한 요청은 버린다.
    c.onResponse(meta("failed"));
    c.onFailed("failed");
    c.onFinished("failed", otherBody);
    expect(otherBody).not.toHaveBeenCalled();

    // base64 본문도 읽는다.
    c.onResponse(meta("a"));
    c.onData("a", 80);
    c.onFinished("a", async () => ({ body: Buffer.from(JSON.stringify({ title: "회원/게임 BE API 개발" })).toString("base64"), base64Encoded: true }));
    // 합계 상한(80 + 80 > 150) — 가져오지 않는다.
    c.onResponse(meta("b"));
    c.onData("b", 80);
    const bBody = body({ b: 1 });
    c.onFinished("b", bBody);
    expect(bBody).not.toHaveBeenCalled();
    // 개수 상한(2).
    c.onResponse(meta("c"));
    c.onData("c", 10);
    c.onFinished("c", body({ c: 1 }));
    c.onResponse(meta("d"));
    c.onData("d", 10);
    const dBody = body({ d: 1 });
    c.onFinished("d", dBody);
    expect(dBody).not.toHaveBeenCalled();

    await c.settled(1_000);
    expect(c.data()).toEqual([{ title: "회원/게임 BE API 개발" }, { c: 1 }]);
  });

  it("JSON 응답 모으기: 끝나지 않는 본문은 짧게만 기다리고, 실제 본문이 상한을 넘거나 JSON이 아니면 버린다", async () => {
    const c = createDataCollector("example.com", { maxDataResponses: 5, maxDataResponseBytes: 20, maxDataBytes: 100 });
    const meta = (id: string) => ({ requestId: id, type: "Fetch", status: 200, url: `https://example.com/${id}`, mimeType: "application/json" });
    c.onResponse(meta("hang"));
    c.onFinished("hang", () => new Promise(() => {}));
    c.onResponse(meta("long")); // dataReceived가 오지 않아도 실제 본문 길이로 다시 거른다.
    c.onFinished("long", async () => ({ body: JSON.stringify({ text: "x".repeat(50) }), base64Encoded: false }));
    c.onResponse(meta("bad"));
    c.onFinished("bad", async () => ({ body: "not json", base64Encoded: false }));
    const started = Date.now();
    await c.settled(100);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(c.data()).toEqual([]);
  });
});

describe("가져오기 작업: 브라우저로 열어 읽기 대체 경로", () => {
  let tdb: TestDb;
  let imports: typeof import("./imports");
  let service: typeof import("./service");

  beforeAll(async () => {
    tdb = await createTestDb();
    imports = await import("./imports");
    service = await import("./service");
  });
  afterAll(() => tdb.close());
  beforeEach(async () => {
    await tdb.reset();
    await tdb.prisma.user.create({ data: { id: "ua", email: "ua@x.com", status: "approved" } });
  });

  it("정적 본문이 빈 껍데기면 AI 분석 전에 브라우저로 열고, 그린 본문으로 추출·근거 검증한다", async () => {
    const r = await imports.createImport("ua", SMILEGATE_URL);
    const statuses: string[] = [];
    const renderPage = vi.fn(async () => {
      statuses.push((await imports.getImport("ua", r.job.id))!.status);
      return renderedSmilegate();
    });
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html: SMILEGATE_HTML }), renderPage });

    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith(SMILEGATE_URL, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(statuses).toEqual(["rendering"]);
    // 헛된 분석 없이 한 번만, 그린 본문으로.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].user).toContain("자격요건");
    expect(spy.mock.calls[0]![0].user).toContain("공유 제목: 스마일게이트(사업부문) 채용");

    const done = await imports.getImport("ua", r.job.id);
    expect(done).toMatchObject({ status: "completed", error: null });
    const posting = await service.getPosting("ua", done!.postingId!);
    expect(posting).toMatchObject({ company: "스마일게이트(사업부문)", roleTitle: "회원/게임 BE API 개발", deadline: "2026-12-31", url: SMILEGATE_URL });
    expect(posting!.sourceText).toContain("Java/Spring 기반 서버 개발 경력 3년 이상");
    expect(posting!.sourceText).toContain("근무지: 경기 성남시 분당구 판교");
  });

  it("정적 본문은 충분하지만 AI가 회사·직무를 찾지 못하면 그때 브라우저로 열어 한 번 더 분석한다", async () => {
    const html = `<html><body><h1>채용 안내</h1><p>${"지원서는 온라인으로만 접수합니다. 자세한 내용은 아래를 확인하세요. ".repeat(40)}</p><div data-bind="html: detail"></div></body></html>`;
    expect(needsRendering(html, postingPageText(html))).toBe(false);
    const r = await imports.createImport("ua", SMILEGATE_URL);
    const renderPage = vi.fn(async () => renderedSmilegate());
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html }), renderPage });
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0].user).not.toContain("자격요건");
    expect(spy.mock.calls[1]![0].user).toContain("자격요건");
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });

  it("정적 본문으로 끝나는 보통 공고는 브라우저를 열지 않는다", async () => {
    const r = await imports.createImport("ua", "https://jobs.example/pay/1");
    const renderPage = vi.fn(async () => renderedSmilegate());
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: STATIC_POSTING_HTML }), renderPage });
    expect(renderPage).not.toHaveBeenCalled();
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });

  it("브라우저로 연 화면이 보안 검사면 차단 안내(errorCode 'blocked')로 끝나고 AI를 부르지 않는다", async () => {
    const r = await imports.createImport("ua", SMILEGATE_URL);
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const challenge = "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={cType:'managed'};</script></body></html>";
    await imports.runImport(r.job.id, {
      llm,
      fetchPage: async (url) => ({ url, html: SMILEGATE_HTML }),
      renderPage: async () => renderedSmilegate({ status: 403, headers: { "cf-mitigated": "challenge" }, html: challenge, text: "Just a moment...", data: [] }),
    });
    expect(spy).not.toHaveBeenCalled();
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", error: POSTING_BLOCKED_ERROR, errorCode: "blocked" });
  });

  it("브라우저 열기에 실패하고 정적 본문으로도 못 찾으면 열기 실패 문구를 남긴다(내부 내용은 숨긴다)", async () => {
    const run = async (renderPage: import("./render").RenderPageFn) => {
      const r = await imports.createImport("ua", `${SMILEGATE_URL}&n=${Math.random()}`);
      await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: SMILEGATE_HTML }), renderPage });
      return imports.getImport("ua", r.job.id);
    };
    expect(
      await run(async () => {
        throw new PostingRenderError(RENDER_TIMEOUT_ERROR);
      }),
    ).toMatchObject({ status: "failed", error: RENDER_TIMEOUT_ERROR, errorCode: null });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await run(async () => {
      throw new Error("Protocol error: Target closed 10.0.0.5 INTERNAL_SECRET");
    });
    errors.mockRestore();
    expect(failed).toMatchObject({ status: "failed", error: RENDER_GENERIC_ERROR });
    expect(failed?.error).not.toContain("INTERNAL_SECRET");

    // 오류 상태 코드(보안 검사 아님)도 열기 실패로 본다.
    expect(await run(async () => renderedSmilegate({ status: 404, html: "<html></html>", text: "Not Found" }))).toMatchObject({
      status: "failed",
      error: expect.stringContaining("HTTP 404"),
    });
  });

  it("열어 읽기를 끄면(renderPage null) 예전처럼 회사·직무 확인 실패로 끝난다", async () => {
    const r = await imports.createImport("ua", SMILEGATE_URL);
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: SMILEGATE_HTML }), renderPage: null });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("회사와 모집 직무") });
  });

  it("'페이지 열어 읽는 중'(rendering)도 진행 중으로 보고, 멈추면 다시 실행한다", async () => {
    const { isPostingImportActive, POSTING_IMPORT_STATUS_LABELS } = await import("@/lib/domain/postings");
    expect(isPostingImportActive("rendering")).toBe(true);
    expect(POSTING_IMPORT_STATUS_LABELS.rendering).toBe("페이지 열어 읽는 중");
    const r = await imports.createImport("ua", SMILEGATE_URL);
    await tdb.prisma.postingImport.update({ where: { id: r.job.id }, data: { status: "rendering", attempts: 1, updatedAt: new Date(Date.now() - 6 * 60_000) } });
    expect(imports.isImportStale((await imports.getImport("ua", r.job.id))!)).toBe(true);
    // 같은 URL을 다시 넣으면 멈춘 작업은 재사용하지 않는다(진행 중 판정에 rendering 포함).
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: SMILEGATE_HTML }), renderPage: async () => renderedSmilegate() });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });
});
