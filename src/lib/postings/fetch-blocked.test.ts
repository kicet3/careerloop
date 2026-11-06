/**
 * 봇 차단(보안 검사) 페이지 판별(인터넷에 접속하지 않음 — 연결 함수를 가짜로 주입). 우회하지 않고 code 'blocked'로 끝내
 * 사용자에게 본문 붙여넣기를 안내하는지. 픽스처는 careers.nexon.com의 실제 Cloudflare 관리형 검사 응답을 줄인 것(토큰·이미지는 가렸다).
 */
import { describe, expect, it, vi } from "vitest";
import { POSTING_BLOCKED_ERROR } from "@/lib/domain/postings";

vi.mock("server-only", () => ({}));

const { fetchPostingPage, isBotChallengeResponse, looksLikeChallengeText, PostingFetchError } = await import("./fetch");
const { postingPageText } = await import("./page-text");

/** careers.nexon.com/recruit/10460 (2026-11) 응답 본문을 줄인 것. */
const CLOUDFLARE_CHALLENGE_HTML = `<!doctype html>
<html lang="ko-kr">
<head><meta charset="UTF-8"><title>NEXON</title><meta http-equiv="refresh" content="360"></head>
<body>
<div style="text-align:center">
  <h1><img src="data:image/png;base64,XX" /></h1>
  <h2>접속을 위해 보안 검사를 진행해 주세요.</h2>
  <div class="wrap"><div class="main-wrapper" role="main"><div class="main-content"><noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript></div></div>
  <script>(function(){window._cf_chl_opt = {cvId: '3',cZone: 'careers.nexon.com',cType: 'managed',cRay: 'REDACTED'};var a = document.createElement('script');a.src = '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=REDACTED';document.getElementsByTagName('head')[0].appendChild(a);}());</script></div>
  <h3>보안 검사가 정상적으로 진행되지 않을 경우 <br>1:1 문의를 이용해주시기 바랍니다. </h3>
  <div><a href="https://help.nexon.com/QnA/QnAGuide">고객센터 문의 바로가기 ></a></div>
</div>
</body>
</html>`;

const CF_HEADERS = { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge", server: "cloudflare" };
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const respond = (status: number, headers: Record<string, string>, body: string) => async () => ({
  status,
  headers,
  body: new TextEncoder().encode(body),
});

async function fetchError(connect: ReturnType<typeof respond>): Promise<InstanceType<typeof PostingFetchError>> {
  const err = await fetchPostingPage("https://careers.example/recruit/1", { lookup: publicLookup, connect }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PostingFetchError);
  return err as InstanceType<typeof PostingFetchError>;
}

describe("isBotChallengeResponse", () => {
  it("cf-mitigated: challenge 헤더는 상태·본문과 무관하게 차단", () => {
    expect(isBotChallengeResponse({ status: 403, headers: { "cf-mitigated": "challenge" }, html: "" })).toBe(true);
    expect(isBotChallengeResponse({ status: 200, headers: { "cf-mitigated": "challenge" }, html: "" })).toBe(true);
  });

  it("헤더가 없어도 403/503 본문의 Cloudflare 검사 표식으로 차단을 알아본다", () => {
    expect(isBotChallengeResponse({ status: 403, headers: { server: "cloudflare" }, html: CLOUDFLARE_CHALLENGE_HTML })).toBe(true);
    expect(isBotChallengeResponse({ status: 503, headers: {}, html: "<title>Just a moment...</title>" })).toBe(true);
    expect(isBotChallengeResponse({ status: 403, headers: {}, html: "<title>Verifying you are human. This may take a few seconds.</title>" })).toBe(true);
  });

  it("다른 WAF: AWS WAF 헤더, DataDome·Imperva 표식, Akamai 403", () => {
    expect(isBotChallengeResponse({ status: 405, headers: { "x-amzn-waf-action": "captcha" }, html: "" })).toBe(true);
    expect(isBotChallengeResponse({ status: 403, headers: {}, html: "<script>var dd={'host':'geo.captcha-delivery.com'}</script>" })).toBe(true);
    expect(isBotChallengeResponse({ status: 403, headers: {}, html: "Request unsuccessful. Incapsula incident ID: 123-456" })).toBe(true);
    expect(isBotChallengeResponse({ status: 403, headers: { server: "AkamaiGHost" }, html: "<h1>Access Denied</h1>" })).toBe(true);
  });

  it("보안 검사가 아닌 오류·일반 페이지는 차단으로 보지 않는다", () => {
    expect(isBotChallengeResponse({ status: 404, headers: { server: "cloudflare" }, html: "<h1>Not Found</h1>" })).toBe(false);
    expect(isBotChallengeResponse({ status: 403, headers: { server: "nginx" }, html: "<h1>403 Forbidden</h1>" })).toBe(false);
    // Cloudflare가 일반 페이지에 넣는 감지 스크립트(jsd)만으로는 차단이 아니다.
    const normal = `<h1>백엔드 개발자</h1><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`;
    expect(isBotChallengeResponse({ status: 200, headers: { server: "cloudflare" }, html: normal })).toBe(false);
    // 200이어도 작은 검사 페이지면 차단, 큰 페이지에 표식 문자열이 섞인 정도는 넘긴다.
    expect(isBotChallengeResponse({ status: 200, headers: {}, html: CLOUDFLARE_CHALLENGE_HTML })).toBe(true);
    expect(isBotChallengeResponse({ status: 200, headers: {}, html: `${"<p>공고</p>".repeat(10_000)}window._cf_chl_opt` })).toBe(false);
  });

  it("보호 서비스가 일반 페이지에 심는 감지 스크립트만으로는 차단이 아니다(2xx·403 모두)", () => {
    const spa = (script: string) => `<!doctype html><html><head><title>채용</title>${script}</head><body><div id=app></div></body></html>`;
    const sensors = [
      '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>', // Cloudflare 감지 스크립트(현재 경로)
      '<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/abc123/main.js"></script>', // 같은 스크립트의 예전 경로
      '<script src="/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"></script>', // Imperva
      '<script src="https://abc.edge.sdk.awswaf.com/abc/def/challenge.js" defer></script>', // AWS WAF 연동 SDK
      '<script src="https://js.datadome.co/tags.js" async></script>', // DataDome 태그
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>', // 폼의 Turnstile 위젯
    ];
    for (const script of sensors) {
      expect(isBotChallengeResponse({ status: 200, headers: { server: "cloudflare" }, html: spa(script) })).toBe(false);
    }
    // Cloudflare 뒤 사이트가 마감·비공개 공고에 403 + 자체 오류 페이지(감지 스크립트 포함)를 주는 경우 → 기존 '사라졌습니다' 안내.
    const closed = `<h1>마감되었거나 비공개 처리된 공고입니다.</h1>${sensors[0]}${sensors[5]}`;
    expect(isBotChallengeResponse({ status: 403, headers: { server: "cloudflare" }, html: closed })).toBe(false);
  });

  it("검사 안내 문구만 남은 짧은 본문을 알아본다(긴 공고 본문의 우연한 단어는 넘긴다)", () => {
    expect(looksLikeChallengeText(postingPageText(CLOUDFLARE_CHALLENGE_HTML))).toBe(true);
    expect(looksLikeChallengeText("Just a moment...\nChecking if the site connection is secure")).toBe(true);
    expect(looksLikeChallengeText("회사: 페이랩\n모집 직무: 백엔드")).toBe(false);
    expect(looksLikeChallengeText(`${"정보보안 담당자를 채용합니다. ".repeat(200)}보안 검사를 진행`)).toBe(false);
  });
});

describe("fetchPostingPage: 차단 페이지는 code 'blocked'", () => {
  it("Cloudflare 관리형 검사(실제 넥슨 채용 응답 모양) → 본문 붙여넣기 안내", async () => {
    const err = await fetchError(respond(403, CF_HEADERS, CLOUDFLARE_CHALLENGE_HTML));
    expect(err.code).toBe("blocked");
    expect(err.message).toBe(POSTING_BLOCKED_ERROR);
    expect(err.message).toContain("본문 붙여넣어 가져오기");
  });

  it("gzip 본문의 표식도 읽는다(헤더 없이)", async () => {
    const { gzipSync } = await import("node:zlib");
    const body = gzipSync(Buffer.from(CLOUDFLARE_CHALLENGE_HTML));
    const connect = async () => ({ status: 403, headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: new Uint8Array(body) });
    expect((await fetchError(connect)).code).toBe("blocked");
  });

  it("200으로 온 검사 페이지도 차단으로 끝낸다", async () => {
    const err = await fetchError(respond(200, { "content-type": "text/html" }, CLOUDFLARE_CHALLENGE_HTML));
    expect(err.code).toBe("blocked");
  });

  it("보통의 403·404는 기존 문구 그대로(code 없음)", async () => {
    const err = await fetchError(respond(403, { "content-type": "text/html" }, "<h1>Forbidden</h1>"));
    expect(err.code).toBeNull();
    expect(err.message).toContain("사라졌습니다");
  });

  it("Cloudflare 감지 스크립트가 든 403 오류 페이지도 code 없음", async () => {
    const html = '<h1>공고를 찾을 수 없습니다</h1><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
    const err = await fetchError(respond(403, { "content-type": "text/html", server: "cloudflare" }, html));
    expect(err.code).toBeNull();
  });
});
