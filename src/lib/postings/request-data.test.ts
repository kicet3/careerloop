/**
 * 데이터 요청(브라우저 없이 페이지의 공개 데이터 주소를 GET): 스크립트에서 데이터 주소 찾기(실제 Smilegate 정적 응답의 스크립트 픽스처),
 * 받은 JSON → 본문(실제 /api/apply/announce/guest/6217 응답을 줄인 픽스처), 요청 예산·SSRF 방어(가짜 연결 주입 — 인터넷에 접속하지 않음),
 * 가져오기 작업의 경로 순서(정적 → 데이터 요청 → 브라우저, PGlite·가짜 LLM).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTING_BLOCKED_ERROR, POSTING_LIMITS } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const { discoverDataEndpoints, pageIdentifiers, pageScripts, appScriptUrls, isPostingLikeData, requestedPageText, requestedHtmlText, POSTING_DATA_DISCOVERY } = await import(
  "./data-endpoints"
);
const { requestPostingData, POSTING_REQUEST } = await import("./request-data");
const { jsonEvidenceLines, compactDateText, needsRendering } = await import("./rendered-text");
const { postingPageText } = await import("./page-text");
const { postingBlockedError, PostingFetchError } = await import("./fetch");
const { PostingRenderError, RENDER_TIMEOUT_ERROR } = await import("./render");

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf8");
/** careers.smilegate.com/apply/announce/view?seq=6217 정적 응답의 스크립트 부분(원문). */
const SCRIPTS_HTML = fixture("smilegate-announce-6217-scripts.html");
/** 같은 공고의 비로그인 상세 API 응답(관련 공고 1개만 남기고 회사 정보 일부를 줄였다). */
const GUEST_JSON = JSON.parse(fixture("smilegate-announce-guest-6217.json")) as Record<string, unknown>;
const PAGE_URL = "https://careers.smilegate.com/apply/announce/view?seq=6217";
const GUEST_URL = "https://careers.smilegate.com/api/apply/announce/guest/6217";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const enc = (s: string) => new TextEncoder().encode(s);
type Connect = NonNullable<import("./fetch").FetchDeps["connect"]>;
const json = (body: unknown, status = 200) => ({ status, headers: { "content-type": "application/json;charset=UTF-8" }, body: enc(JSON.stringify(body)) });

describe("데이터 주소 찾기(discoverDataEndpoints)", () => {
  it("Smilegate 스크립트에서 비로그인 상세 API(guest)를 첫 후보로 찾고, 쓰기·목록·다른 API는 넣지 않는다", () => {
    const { inline } = pageScripts(SCRIPTS_HTML);
    const found = discoverDataEndpoints(new URL(PAGE_URL), inline);
    expect(found[0]).toBe(GUEST_URL);
    expect(found).toContain("https://careers.smilegate.com/api/apply/announce/6217");
    expect(found.length).toBeLessThanOrEqual(POSTING_DATA_DISCOVERY.maxCandidates);
    for (const url of found) {
      expect(url.startsWith("https://careers.smilegate.com/api/")).toBe(true);
      expect(url).not.toMatch(/faq|etc\/pop|noPop|checkPassword|interest|\/api\/apply\/info/);
      expect(url).toContain("6217");
      // data.projectSeq(응답 안의 프로젝트 번호)에는 공고 번호를 넣지 않는다.
      expect(url).not.toContain("/api/apply/project/");
    }
  });

  it("다른 대상의 번호 변수(categoryId·companyId·userId·점 표기 속성)에는 페이지 식별자를 넣지 않는다", () => {
    const page = new URL("https://jobs.example/positions/9983");
    expect(
      discoverDataEndpoints(page, [
        'get("/api/recruit/list?categoryId=" + categoryId); get("/api/company/" + data.companyId); get("/api/user/" + userId); get(`/api/x/${self.detail().positionId}`)',
      ]),
    ).toEqual([]);
    // 맨 이름·쿼리 이름·페이지 경로 마디로 시작하는 이름은 바꾼다.
    expect(discoverDataEndpoints(page, ['get("/api/a/" + id); get("/api/b/" + positionId); get("/api/c/" + position_no);'])).toEqual([
      "https://jobs.example/api/a/9983",
      "https://jobs.example/api/b/9983",
      "https://jobs.example/api/c/9983",
    ]);
    expect(discoverDataEndpoints(new URL(PAGE_URL), ['var u = "/api/apply/announce"; get(u + "/" + announceSeq); get(u + "/x/" + seq);'])).toEqual([
      "https://careers.smilegate.com/api/apply/announce/x/6217",
      "https://careers.smilegate.com/api/apply/announce/6217",
    ]);
  });

  it("페이지 식별자: 숫자가 든 쿼리 값과 끝쪽 경로 마디(추적 파라미터 제외)", () => {
    expect(pageIdentifiers(new URL(PAGE_URL))).toEqual([{ value: "6217", param: "seq" }]);
    expect(pageIdentifiers(new URL("https://careers.nexon.com/recruit/10549?utm_source=x1"))).toEqual([{ value: "10549", param: null }]);
    expect(pageIdentifiers(new URL("https://jobs.example/positions/view"))).toEqual([]);
    // 식별자가 없으면 후보도 없다.
    expect(discoverDataEndpoints(new URL("https://jobs.example/careers"), ['var u = "/api/jobs/" + id;'])).toEqual([]);
  });

  it("템플릿 문자열·변수 대입을 풀고, 다른 출처·스킴 상대 주소는 버린다", () => {
    const page = new URL("https://jobs.example/positions/9983");
    expect(discoverDataEndpoints(page, ["fetch(`/api/v2/positions/${positionId}`)"])).toEqual(["https://jobs.example/api/v2/positions/9983"]);
    expect(discoverDataEndpoints(page, ['const BASE = "https://jobs.example/api/pos"; get(BASE + "/" + id);'])).toEqual(["https://jobs.example/api/pos/9983"]);
    expect(
      discoverDataEndpoints(page, [
        'get("https://evil.example/api/jobs/" + id); get("//evil.example/api/" + id); get("javascript:/api/" + id); get(`http://jobs.example:8080/api/${id}`)',
      ]),
    ).toEqual([]);
  });

  it("이어 붙이기가 없으면 페이지 경로와 마디가 같은 데이터 주소로 후보를 만든다(낮은 순위)", () => {
    const page = new URL("https://recruit.example/notice/view?no=55");
    expect(discoverDataEndpoints(page, ['var API = "/api/notice"; var other = "/api/banner";'])).toEqual([
      "https://recruit.example/api/notice/55",
      "https://recruit.example/api/notice?no=55",
    ]);
  });

  it("외부 스크립트는 같은 출처의 앱 스크립트만(라이브러리 제외) 최대 3개", () => {
    const { sources } = pageScripts(SCRIPTS_HTML);
    expect(appScriptUrls(sources, new URL(PAGE_URL))).toEqual([
      "https://careers.smilegate.com/assets/js/common.js?ver=3",
      "https://careers.smilegate.com/assets/js/callAjax.js",
    ]);
    const many = ["/a.js", "https://cdn.other/b.js", "/c.js", "/d.js", "/e.js"];
    expect(appScriptUrls(many, new URL(PAGE_URL))).toHaveLength(3);
  });
});

describe("받은 데이터 → 본문(requestedPageText)", () => {
  it("실제 상세 JSON: 제목·회사·마감·자격 등을 줄로 펴고, 이중 이스케이프된 HTML 설명을 텍스트로 푼다", () => {
    const text = requestedPageText(SCRIPTS_HTML, GUEST_JSON, new URL(PAGE_URL))!;
    expect(text).toBeTruthy();
    expect(text.length).toBeLessThanOrEqual(POSTING_LIMITS.jdText);
    expect(text.startsWith("페이지 제목: Smilegate Careers\n공유 제목: 스마일게이트(사업부문) 채용")).toBe(true);
    expect(text).toContain("title: [퍼블리싱/플랫폼] 회원/게임 BE API 개발");
    expect(text).toContain("companyNm: 스마일게이트(사업부문)");
    expect(text).toContain("endDate: 2026-11-30");
    expect(text).toContain("- Java 언어 사용에 능숙한 자");
    expect(text).toContain("기타 안내사항");
    expect(text).not.toMatch(/&lt;|&amp;|<td|<p>/);
    // 코드값·이미지 경로는 넣지 않는다.
    expect(text).not.toContain("CER002");
    expect(text).not.toContain(".png");
  });

  it("공고처럼 보이지 않는 응답(짧은 상태 값·코드 목록)은 쓰지 않는다", () => {
    expect(requestedPageText(SCRIPTS_HTML, { result: "ok", code: 401 }, new URL(PAGE_URL))).toBeNull();
    expect(requestedPageText(SCRIPTS_HTML, "문자열", new URL(PAGE_URL))).toBeNull();
    expect(isPostingLikeData(["message: 로그인이 필요합니다."])).toBe(false);
    expect(isPostingLikeData(jsonEvidenceLines([GUEST_JSON], ""))).toBe(true);
  });

  it("목록 응답·다른 공고의 상세는 쓰지 않는다(이 페이지의 공고 한 건만)", () => {
    const page = new URL(PAGE_URL);
    const item = (n: number) => ({ announceSeq: 7000 + n, title: `다른 공고 ${n}`, jobDesc: "서버 개발 업무를 담당합니다. ".repeat(10), qualification: "경력 3년 이상 ".repeat(10) });
    const list = [item(1), item(2)];
    expect(isPostingLikeData(jsonEvidenceLines([{ list }], ""))).toBe(true);
    for (const data of [list, { list }, { items: list, total: 2 }, { content: list, page: 1 }, { data: { list } }]) expect(requestedPageText(SCRIPTS_HTML, data, page)).toBeNull();
    // 목록 안에 이 공고 번호가 있어도 목록이면 쓰지 않는다.
    expect(requestedPageText(SCRIPTS_HTML, { list: [{ ...item(1), announceSeq: 6217 }, item(2)] }, page)).toBeNull();
    // 공고 한 건이지만 번호·제목이 이 페이지가 아니다(쿼리를 무시하고 다른 공고를 주는 API).
    expect(requestedPageText(SCRIPTS_HTML, { ...GUEST_JSON, announceSeq: 7001 }, page)).toBeNull();
    // 한 겹 감싼 상세·한 건짜리 배열은 쓴다.
    expect(requestedPageText(SCRIPTS_HTML, { data: GUEST_JSON }, page)).toContain("companyNm: 스마일게이트(사업부문)");
    expect(requestedPageText(SCRIPTS_HTML, [GUEST_JSON], page)).toContain("companyNm: 스마일게이트(사업부문)");
    // 번호가 없어도 제목이 페이지 공유 제목과 맞으면 쓴다.
    const titled = `<head><meta property="og:title" content="[퍼블리싱/플랫폼] 회원/게임 BE API 개발 | 스마일게이트"></head>`;
    expect(requestedPageText(titled, { ...GUEST_JSON, announceSeq: null }, page)).toBeTruthy();
  });

  it("HTML 응답: 이 공고 번호가 든 상세 조각만 — 사이트 껍데기·정적 페이지와 같은 본문은 버린다", () => {
    const page = new URL(PAGE_URL);
    const body = `<p>${"플랫폼 백엔드 API 개발 업무와 자격 요건 안내입니다. ".repeat(20)}</p>`;
    expect(requestedHtmlText(SCRIPTS_HTML, `<div data-seq="6217">${body}</div>`, page, postingPageText)).toContain("플랫폼 백엔드");
    // 번호가 없는 조각(모르는 경로의 공용 안내).
    expect(requestedHtmlText(SCRIPTS_HTML, `<div>${body}</div>`, page, postingPageText)).toBeNull();
    // 번호가 없고 정적 페이지와 제목이 같은 전체 문서(사이트 껍데기).
    const shell = `<html><head><title>Smilegate Careers</title></head><body><a href="?seq=6217">메뉴</a>${body}</body></html>`;
    expect(requestedHtmlText(SCRIPTS_HTML, shell, page, postingPageText)).toBeNull();
    // 정적 페이지와 같은 본문.
    const same = `<html><body><i>6217</i>${body}</body></html>`;
    expect(requestedHtmlText(same, same, page, postingPageText)).toBeNull();
    // 한글이 적은 응답.
    expect(requestedHtmlText(SCRIPTS_HTML, "<div>6217 ok</div>", page, postingPageText)).toBeNull();
  });

  it("날짜 키의 붙여 쓴 날짜만 바꾼다", () => {
    expect(compactDateText("endDate", "20261130")).toBe("2026-11-30");
    expect(compactDateText("reg_dt", 202611302359)).toBe("2026-11-30 23:59");
    expect(compactDateText("announceSeq", "20261130")).toBeNull();
    expect(compactDateText("endDate", "20261340")).toBeNull();
  });
});

describe("데이터 요청(requestPostingData — 가짜 연결)", () => {
  const page = { url: PAGE_URL, html: SCRIPTS_HTML };

  it("guest 상세를 GET 1회로 받아 멈춘다(JSON Accept·Referer, 쿠키 없음)", async () => {
    const seen: { url: string; headers?: import("./fetch").RequestHeaders }[] = [];
    const connect: Connect = async ({ url }, opts) => {
      seen.push({ url: url.href, headers: opts.headers });
      return url.href === GUEST_URL ? json(GUEST_JSON) : json({ message: "Unauthorized" }, 401);
    };
    const r = await requestPostingData(page, { lookup: publicLookup, connect, signal: new AbortController().signal });
    expect(r).toMatchObject({ kind: "found", dataUrl: GUEST_URL, requests: 1 });
    expect(r.kind === "found" && r.pageText).toContain("companyNm: 스마일게이트(사업부문)");
    expect(seen).toEqual([{ url: GUEST_URL, headers: { accept: expect.stringContaining("application/json"), referer: PAGE_URL } }]);
  });

  it("401·공고 아닌 응답은 넘기고 다음 후보로, 다 실패하면 'none'", async () => {
    const urls: string[] = [];
    const connect: Connect = async ({ url }) => {
      urls.push(url.href);
      return url.pathname.includes("guest") ? json({ result: "ok" }) : json({}, 401);
    };
    const r = await requestPostingData(page, { lookup: publicLookup, connect, signal: new AbortController().signal });
    expect(r.kind).toBe("none");
    expect(urls[0]).toBe(GUEST_URL);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.length).toBeLessThanOrEqual(POSTING_REQUEST.maxRequests);
  });

  it("SSRF: 데이터 주소가 내부 주소로 풀리면 접속하지 않고, 다른 출처로의 리다이렉트는 따르지 않는다", async () => {
    const connect = vi.fn<Connect>(async () => json(GUEST_JSON));
    const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
    expect(await requestPostingData(page, { lookup: privateLookup, connect, signal: new AbortController().signal })).toMatchObject({ kind: "none" });
    expect(connect).not.toHaveBeenCalled();

    const hops: string[] = [];
    const redirecting: Connect = async ({ url }) => {
      hops.push(url.href);
      return url.hostname === "careers.smilegate.com"
        ? { status: 302, headers: { location: "https://attacker.example/api/x" }, body: enc("") }
        : json(GUEST_JSON);
    };
    expect(await requestPostingData(page, { lookup: publicLookup, connect: redirecting, signal: new AbortController().signal })).toMatchObject({
      kind: "none",
    });
    expect(hops.every((u) => u.startsWith("https://careers.smilegate.com/"))).toBe(true);
  });

  it("예산: 요청 수 상한·경로 전체 시간 상한", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `get("/api/v1/jobs${i}/" + seq);`).join("\n");
    const html = `<script>${many}</script>`;
    const connect = vi.fn<Connect>(async () => json({}, 404));
    await requestPostingData({ url: PAGE_URL, html }, { lookup: publicLookup, connect, signal: new AbortController().signal, limits: { maxRequests: 3 } });
    expect(connect).toHaveBeenCalledTimes(3);

    const hang: Connect = (_t, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const started = Date.now();
    const r = await requestPostingData({ url: PAGE_URL, html }, { lookup: publicLookup, connect: hang, signal: new AbortController().signal, limits: { totalTimeoutMs: 150 } });
    expect(r.kind).toBe("none");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("호출자 취소는 그대로 던지고, 보안 검사 응답이면 'blocked'", async () => {
    const ac = new AbortController();
    const reason = new Error("import timeout");
    const hang: Connect = (_t, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
        ac.abort(reason);
      });
    await expect(requestPostingData(page, { lookup: publicLookup, connect: hang, signal: ac.signal })).rejects.toBe(reason);

    const challenge: Connect = async () => ({ status: 403, headers: { "content-type": "text/html", "cf-mitigated": "challenge" }, body: enc("<title>Just a moment...</title>") });
    expect(await requestPostingData(page, { lookup: publicLookup, connect: challenge, signal: new AbortController().signal })).toMatchObject({
      kind: "blocked",
      requests: 1,
    });
  });

  it("인라인 스크립트에서 못 찾으면 같은 출처 앱 스크립트 파일을 읽어 찾는다", async () => {
    const html = `<script src="/assets/js/jquery-3.5.1.min.js"></script><script src="/static/app.js"></script>`;
    const urls: string[] = [];
    const connect: Connect = async ({ url }) => {
      urls.push(url.href);
      if (url.pathname === "/static/app.js") return { status: 200, headers: { "content-type": "application/javascript" }, body: enc('var api = "/api/apply/announce"; get(api + "/guest/" + seq);') };
      return url.href === GUEST_URL ? json(GUEST_JSON) : json({}, 404);
    };
    const r = await requestPostingData({ url: PAGE_URL, html }, { lookup: publicLookup, connect, signal: new AbortController().signal });
    expect(r).toMatchObject({ kind: "found", dataUrl: GUEST_URL, requests: 2 });
    expect(urls).toEqual(["https://careers.smilegate.com/static/app.js", GUEST_URL]);
  });
});

describe("가져오기 작업: 정적 → 데이터 요청 → 브라우저", () => {
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

  /** 가짜 LLM이 읽는 꼴(회사:·직무:)로 키를 둔 상세 데이터. */
  const DETAIL = {
    announceSeq: 6217,
    title: "[퍼블리싱/플랫폼] 회원/게임 BE API 개발",
    회사: "스마일게이트(사업부문)",
    직무: "회원/게임 BE API 개발",
    endDate: "20261130",
    workInfo: "- 플랫폼 백엔드 API 개발\n- 대규모 트래픽 처리를 위한 아키텍처 분석/설계",
    qualificationDesc: "- 관련 분야 개발 경력 5년 이상\n- Java 언어 사용에 능숙한 자",
  };
  const realRequester =
    (body: unknown): import("./request-data").RequestDataFn =>
    (p, { signal }) =>
      requestPostingData(p, { lookup: publicLookup, connect: async ({ url }) => (url.href === GUEST_URL ? json(body) : json({}, 401)), signal });
  const rendered = () => ({
    url: PAGE_URL,
    status: 200,
    headers: { "content-type": "text/html" },
    html: SCRIPTS_HTML,
    text: "회사: 스마일게이트(사업부문)\n직무: 회원/게임 BE API 개발\n자격요건\n- Java/Spring 기반 서버 개발 경력 3년 이상\n" + "채용 안내 문구입니다. ".repeat(20),
    data: [],
  });
  const tracked = async (id: string) => (await imports.getImport("ua", id))!.status;

  it("빈 껍데기 정적 본문 → 데이터 요청으로 끝나면 브라우저를 열지 않는다(AI 1회, 출처 링크는 공고 주소)", async () => {
    expect(needsRendering(SCRIPTS_HTML, postingPageText(SCRIPTS_HTML))).toBe(true);
    const r = await imports.createImport("ua", PAGE_URL);
    const statuses: string[] = [];
    const inner = realRequester(DETAIL);
    const requestData = vi.fn<import("./request-data").RequestDataFn>(async (p, o) => {
      statuses.push(await tracked(r.job.id));
      return inner(p, o);
    });
    const renderPage = vi.fn(async () => rendered());
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html: SCRIPTS_HTML }), requestData, renderPage });

    expect(requestData).toHaveBeenCalledTimes(1);
    expect(requestData).toHaveBeenCalledWith({ url: PAGE_URL, html: SCRIPTS_HTML }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(statuses).toEqual(["requesting"]);
    expect(renderPage).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].user).toContain("qualificationDesc: - 관련 분야 개발 경력 5년 이상");
    const done = await imports.getImport("ua", r.job.id);
    expect(done).toMatchObject({ status: "completed", error: null });
    const posting = await service.getPosting("ua", done!.postingId!);
    expect(posting).toMatchObject({ company: "스마일게이트(사업부문)", roleTitle: "회원/게임 BE API 개발", url: PAGE_URL });
    expect(posting!.sourceText).toContain("Java 언어 사용에 능숙한 자");
  });

  it("데이터 요청이 아무것도 찾지 못하면 브라우저로 연다(requesting → rendering)", async () => {
    const r = await imports.createImport("ua", PAGE_URL);
    const statuses: string[] = [];
    const requestData = vi.fn<import("./request-data").RequestDataFn>(async () => {
      statuses.push(await tracked(r.job.id));
      return { kind: "none", requests: 2, candidates: 2 };
    });
    const renderPage = vi.fn(async () => {
      statuses.push(await tracked(r.job.id));
      return rendered();
    });
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html: SCRIPTS_HTML }), requestData, renderPage });
    expect(statuses).toEqual(["requesting", "rendering"]);
    // 막히지 않은 빈 껍데기 페이지는 기존 동작 그대로(honestUserAgent 없음).
    expect(renderPage.mock.calls[0]).toEqual([PAGE_URL, { signal: expect.any(AbortSignal) }]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });

  it("받은 데이터로 회사·직무를 못 찾으면 브라우저로 한 번 더(AI는 경로마다 1회)", async () => {
    const r = await imports.createImport("ua", PAGE_URL);
    const renderPage = vi.fn(async () => rendered());
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const noCompany: Partial<typeof DETAIL> = { ...DETAIL };
    delete noCompany.회사;
    delete noCompany.직무;
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html: SCRIPTS_HTML }), requestData: realRequester({ ...noCompany, description: "모집 부문 안내 ".repeat(20) }), renderPage });
    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]![0].user).toContain("Java/Spring");
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });

  it("정적 본문은 충분하지만 AI가 못 찾으면 데이터 요청으로 다시 — 성공하면 브라우저는 열지 않는다", async () => {
    const html = SCRIPTS_HTML.replace("<body>", `<body><p>${"지원서는 온라인으로만 접수합니다. 자세한 내용은 아래를 확인하세요. ".repeat(40)}</p>`);
    expect(needsRendering(html, postingPageText(html))).toBe(false);
    const r = await imports.createImport("ua", PAGE_URL);
    const renderPage = vi.fn(async () => rendered());
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html }), requestData: realRequester(DETAIL), renderPage });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(renderPage).not.toHaveBeenCalled();
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });

  it("정적 응답이 보안 검사면 데이터 요청은 건너뛰고 브라우저로 한 번 연다 — 그래도 검사면 'blocked'", async () => {
    const run = async (renderPage: import("./render").RenderPageFn | null) => {
      const r = await imports.createImport("ua", `https://careers.nexon.com/recruit/10549?n=${Math.random()}`);
      const requestData = vi.fn<import("./request-data").RequestDataFn>(async () => ({ kind: "none", requests: 0, candidates: 0 }));
      const llm = new FakeLlmClient();
      const spy = vi.spyOn(llm, "generate");
      const fetchPage = async () => {
        throw postingBlockedError();
      };
      await imports.runImport(r.job.id, { llm, fetchPage, requestData, renderPage });
      expect(requestData).not.toHaveBeenCalled();
      return { job: await imports.getImport("ua", r.job.id), llmCalls: spy.mock.calls.length };
    };
    const challenge = vi.fn(async () => ({
      ...rendered(),
      status: 403,
      headers: { "cf-mitigated": "challenge" },
      html: "<title>Just a moment...</title><script>window._cf_chl_opt={}</script>",
      text: "접속을 위해 보안 검사를 진행해 주세요.",
    }));
    const stillBlocked = await run(challenge);
    expect(challenge).toHaveBeenCalledTimes(1);
    // 막힌 걸 알고 다시 여는 경우는 User-Agent를 바꾸지 않는다(헤드리스 표시 그대로).
    expect(challenge).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ honestUserAgent: true }));
    expect(stillBlocked).toMatchObject({ job: { status: "failed", error: POSTING_BLOCKED_ERROR, errorCode: "blocked" }, llmCalls: 0 });

    // 열지 못해도(시간 초과·브라우저 없음) 차단 안내로 끝낸다.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failedOpen = await run(async () => {
      throw new PostingRenderError(RENDER_TIMEOUT_ERROR);
    });
    expect(failedOpen.job).toMatchObject({ status: "failed", errorCode: "blocked" });
    // 브라우저를 쓰지 않는 설정이면 예전처럼 바로 차단 안내.
    expect((await run(null)).job).toMatchObject({ status: "failed", errorCode: "blocked" });
    // 브라우저로 열린 화면에 공고가 있으면 그 본문으로 추가한다.
    expect((await run(async () => rendered())).job).toMatchObject({ status: "completed" });
    warn.mockRestore();
  });

  it("'데이터 요청 중'(requesting)도 진행 중으로 보고, 멈추면 다시 실행한다", async () => {
    const { isPostingImportActive, POSTING_IMPORT_STATUS_LABELS } = await import("@/lib/domain/postings");
    expect(isPostingImportActive("requesting")).toBe(true);
    expect(POSTING_IMPORT_STATUS_LABELS.requesting).toBe("데이터 요청 중");
    const r = await imports.createImport("ua", PAGE_URL);
    await tdb.prisma.postingImport.update({ where: { id: r.job.id }, data: { status: "requesting", attempts: 1, updatedAt: new Date(Date.now() - 6 * 60_000) } });
    expect(imports.isImportStale((await imports.getImport("ua", r.job.id))!)).toBe(true);
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), fetchPage: async (url) => ({ url, html: SCRIPTS_HTML }), requestData: realRequester(DETAIL), renderPage: null });
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "completed" });
  });

  it("PostingFetchError(차단 아님)는 대체 경로 없이 그대로 실패한다", async () => {
    const r = await imports.createImport("ua", PAGE_URL);
    const requestData = vi.fn();
    const renderPage = vi.fn();
    await imports.runImport(r.job.id, {
      llm: new FakeLlmClient(),
      fetchPage: async () => {
        throw new PostingFetchError("공고 사이트에 연결하지 못했습니다.");
      },
      requestData,
      renderPage,
    });
    expect(requestData).not.toHaveBeenCalled();
    expect(renderPage).not.toHaveBeenCalled();
    expect(await imports.getImport("ua", r.job.id)).toMatchObject({ status: "failed", errorCode: null });
  });
});

describe("브라우저 User-Agent(pageUserAgent)", () => {
  it("honest면 실제 값(HeadlessChrome) 그대로, 아니면 기존 치환", async () => {
    const { pageUserAgent } = await import("./browser");
    const ua = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
    expect(pageUserAgent(ua, true)).toBe(ua);
    expect(pageUserAgent(ua, false)).toBe(ua.replace("HeadlessChrome", "Chrome"));
  });
});
