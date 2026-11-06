import "server-only";
/**
 * 공고 페이지 가져오기(서버 전용). 사용자가 준 URL로 서버가 직접 접속하므로 SSRF를 막는다:
 * - 공개 주소만: 사설(10/8·172.16/12·192.168/16)·루프백·CGNAT(100.64/10, Tailscale 등)·링크로컬(169.254/16)·
 *   문서·벤치마크 대역, IPv6는 전역 유니캐스트(2000::/3)만 허용(ULA fc00::/7·링크로컬·IPv4 매핑 주소는 거절).
 * - DNS 결과 고정: 검사한 주소로만 소켓을 연다(검사 뒤 DNS 응답을 바꾸는 리바인딩 방지). 응답 중 하나라도 내부 주소면 거절.
 * - 리다이렉트는 3회까지, 매번 주소를 다시 검사한다. 쿠키·인증 정보는 보내지 않는다.
 * - 본문 2MB, 전체 20초(리다이렉트 포함).
 * CareerLoop(src/server/postingImport/fetch.ts)에서 가져옴 — 원본은 리다이렉트마다 20초를 새로 주고(최대 80초),
 * 모르는 charset에서 TextDecoder 예외가 그대로 났다. 여기서는 전체 마감 하나, utf-8 대체, 연결 함수 주입(테스트)을 더했다.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { POSTING_BLOCKED_ERROR, type PostingImportErrorCode } from "@/lib/domain/postings";
import { parsePostingUrl } from "./url";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 3;

/** 사용자에게 그대로 보여도 되는 가져오기 실패(내부 주소·원본 오류는 담지 않는다). code 'blocked'는 봇 차단(보안 검사) 페이지. */
export class PostingFetchError extends Error {
  readonly code: PostingImportErrorCode | null;
  constructor(message: string, code: PostingImportErrorCode | null = null) {
    super(message);
    this.name = "PostingFetchError";
    this.code = code;
  }
}

/** 봇 차단(보안 검사) 페이지 — 우회하지 않고 본문 붙여넣기를 안내한다. */
export const postingBlockedError = () => new PostingFetchError(POSTING_BLOCKED_ERROR, "blocked");

// ---------------------------------------------------------------------------
// 봇 차단(보안 검사) 페이지 판별 — 우회하지 않는다(사이트의 보호를 존중하고 사용자에게 본문 붙여넣기를 안내).
// 보수적으로: 서비스가 차단을 명시한 헤더, 또는 차단 상태 코드 + 알려진 보안 검사 페이지 표식만 본다.
// ---------------------------------------------------------------------------

/** 차단 응답에 쓰이는 상태 코드(403 Forbidden·429 Too Many Requests·503 Service Unavailable). */
const BLOCK_STATUSES = new Set([403, 429, 503]);

/**
 * 보안 검사(차단) 화면에만 나오는 표식 — 2xx 본문에서도 이것만 본다. 보호 서비스가 일반 페이지에도 심는 감지 스크립트
 * (Cloudflare /cdn-cgi/challenge-platform/…/scripts/jsd/, Imperva /_Incapsula_Resource, AWS WAF SDK *.awswaf.com,
 * DataDome js.datadome.co 등)는 표식으로 쓰지 않는다.
 */
const CHALLENGE_PAGE_MARKERS: readonly RegExp[] = [
  /window\._cf_chl_opt\b/, // Cloudflare 관리형·JS 검사
  /\/cdn-cgi\/challenge-platform\/(?:h\/[a-z]\/)?orchestrate\//, // Cloudflare 검사 오케스트레이션(chl_page·jsch 등)
  /id=["']?cf-browser-verification\b/, // Cloudflare 예전 '브라우저 확인' 페이지
  /geo\.captcha-delivery\.com/, // DataDome 차단·캡차 화면(iframe·dd 설정)
  /id=["']?px-captcha\b/, // HUMAN(PerimeterX) 차단 화면
];

/** 차단 상태 코드(403/429/503)일 때만 보는 표식 — 차단 화면의 제목·문구(일반 오류 페이지에는 나오지 않는 것). */
const BLOCK_PAGE_MARKERS: readonly RegExp[] = [
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i, // Cloudflare
  /Checking (?:if the site connection is secure|your browser before accessing)/i, // Cloudflare
  /Attention Required! \| Cloudflare/, // Cloudflare 차단
  /Verify(?:ing)? you are (?:a )?human/i, // Cloudflare Turnstile 검사 화면
  /보안\s*검사를\s*진행/, // 국내 사이트의 Cloudflare 검사 안내
  /Incapsula incident ID/i, // Imperva 차단
  /Pardon Our Interruption/, // Imperva·Distil
  /\/_sec\/cp_challenge\//, // Akamai Bot Manager 검사
];

/** 2xx 보안 검사 페이지로 볼 본문 상한(바이트). 실제 공고 페이지는 대개 이보다 크다 — 표식이 있어도 큰 페이지는 넘긴다. */
const CHALLENGE_PAGE_MAX_BYTES = 64 * 1024;

/**
 * 응답이 봇 차단(보안 검사) 페이지인지(순수). headers 키는 소문자.
 * - cf-mitigated: challenge(Cloudflare가 검사를 요구했다고 명시), x-amzn-waf-action: challenge|captcha(AWS WAF) — 상태와 무관하게 차단.
 * - 403/429/503: 검사 화면 표식 또는 차단 화면 문구가 본문에 있으면 차단. AkamaiGHost가 403을 돌려주면 차단(Akamai 'Access Denied').
 * - 2xx: 작은 페이지(64KB 이하)에 검사 화면 표식이 있을 때만(검사 페이지를 200으로 주는 경우).
 */
export function isBotChallengeResponse(res: { status: number; headers: Record<string, string | undefined>; html: string }): boolean {
  const header = (k: string) => (res.headers[k] ?? "").toLowerCase();
  if (header("cf-mitigated").includes("challenge")) return true;
  if (/\b(?:challenge|captcha)\b/.test(header("x-amzn-waf-action"))) return true;
  const body = res.html;
  const hasChallenge = CHALLENGE_PAGE_MARKERS.some((m) => m.test(body));
  if (BLOCK_STATUSES.has(res.status)) {
    if (res.status === 403 && header("server").includes("akamaighost")) return true;
    return hasChallenge || BLOCK_PAGE_MARKERS.some((m) => m.test(body));
  }
  return res.status >= 200 && res.status < 300 && hasChallenge && body.length <= CHALLENGE_PAGE_MAX_BYTES;
}

/**
 * 페이지 본문 텍스트가 보안 검사 안내로 보이는지(순수). 표식을 지운 뒤의 텍스트로만 판단해야 할 때(LLM이 '공고 아님'으로
 * 답한 짧은 페이지 등) 쓴다 — 짧은 본문(2,000자 이하)에서 검사 문구가 보일 때만 true.
 */
const CHALLENGE_TEXT = /보안\s*검사를\s*진행|자동\s*입력\s*방지|사람인지\s*확인|Just a moment\.\.\.|Checking (?:if the site connection is secure|your browser)|Verify(?:ing)? you are (?:a )?human|Enable JavaScript and cookies to continue|Attention Required!|Pardon Our Interruption/i;
export function looksLikeChallengeText(text: string): boolean {
  return text.length <= 2000 && CHALLENGE_TEXT.test(text);
}

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  blocked.addSubnet(ip, prefix, "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
// 전역 대역 안의 특수 용도: Teredo·ORCHID 등(2001::/23), 문서용(2001:db8::/32), 6to4(2002::/16), 문서용(3fff::/20).
for (const [ip, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  blocked.addSubnet(ip, prefix, "ipv6");
}

/** 공개(인터넷) 주소인지. IP가 아니면 false. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export interface ResolvedAddress {
  address: string;
  family: number;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface RawPageResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
/** 고정한 주소로 GET 1회. 본문이 maxBytes를 넘으면 PostingFetchError. */
export type ConnectFn = (
  target: { url: URL; address: ResolvedAddress },
  opts: { signal: AbortSignal; maxBytes: number; headers?: RequestHeaders },
) => Promise<RawPageResponse>;

/** 요청마다 바꿀 수 있는 헤더(그 밖의 헤더·쿠키·인증 정보는 보내지 않는다). */
export interface RequestHeaders {
  accept?: string;
  referer?: string;
}

/** 모든 요청의 User-Agent(정직하게 이 서비스를 밝힌다). */
export const READER_USER_AGENT = "ResumePanel/1.0 (job posting reader)";

export interface FetchDeps {
  lookup?: LookupFn;
  connect?: ConnectFn;
  /** 호출자 취소(가져오기 작업 전체 시간 상한 등). */
  signal?: AbortSignal;
  timeoutMs?: number;
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

/** URL 검사 + DNS 확인. 응답 주소 중 하나라도 공개 주소가 아니면 거절한다. */
export async function publicTarget(raw: string, lookup: LookupFn = defaultLookup): Promise<{ url: URL; address: ResolvedAddress }> {
  const url = parsePostingUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: ResolvedAddress[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new PostingFetchError("공고 사이트 주소를 찾지 못했습니다. 링크를 확인하세요.");
    }
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PostingFetchError("외부에 공개된 채용 공고 주소만 가져올 수 있습니다.");
  }
  return { url, address: addresses[0]! };
}

/** node http(s)로 고정한 주소에 접속한다. lookup을 덮어써 DNS를 다시 묻지 않는다(TLS SNI·Host는 원래 호스트 이름). */
const nodeConnect: ConnectFn = ({ url, address }, { signal, maxBytes, headers: extra }) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(
      url,
      {
        agent: false,
        signal,
        headers: {
          "user-agent": READER_USER_AGENT,
          accept: extra?.accept ?? "text/html,application/xhtml+xml",
          "accept-encoding": "gzip, deflate, br",
          ...(extra?.referer ? { referer: extra.referer } : {}),
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) request.destroy(new PostingFetchError("공고 페이지가 너무 큽니다. 개별 공고 상세 링크를 입력하세요."));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status: res.statusCode ?? 500, headers, body: new Uint8Array(Buffer.concat(chunks)) });
        });
      },
    );
    request.on("error", reject);
  });

function decompress(body: Uint8Array, encoding: string | undefined): Uint8Array {
  const enc = (encoding ?? "").trim().toLowerCase();
  const options = { maxOutputLength: MAX_PAGE_BYTES };
  try {
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(body, options);
    if (enc === "br") return brotliDecompressSync(body, options);
    if (enc === "deflate") return inflateSync(body, options);
  } catch {
    // 압축 해제 상한 초과(RangeError) 또는 손상된 본문.
    throw new PostingFetchError("공고 페이지가 너무 크거나 읽을 수 없는 형식입니다. 개별 공고 상세 링크를 입력하세요.");
  }
  if (enc && enc !== "identity") throw new PostingFetchError("공고 페이지의 압축 형식을 읽지 못했습니다.");
  return body;
}

function decodeHtml(body: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] || head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface GetOptions {
  headers?: RequestHeaders;
  maxBytes: number;
  /** 있으면 리다이렉트도 이 출처(origin) 안에서만 따라간다. */
  origin?: string;
}

/**
 * 검사한 주소로 GET(리다이렉트는 매번 다시 검사, MAX_REDIRECTS까지). 리다이렉트가 아닌 첫 응답과 그 주소를 돌려준다.
 * 실패는 PostingFetchError/PostingUrlError(사용자용 문구) 또는 호출자 취소의 reason.
 */
async function guardedGet(raw: string, deps: FetchDeps, opts: GetOptions): Promise<{ target: { url: URL; address: ResolvedAddress }; res: RawPageResponse }> {
  const lookup = deps.lookup ?? defaultLookup;
  const connect = deps.connect ?? nodeConnect;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;

  let current = raw;
  for (let redirects = 0; ; redirects++) {
    const target = await publicTarget(current, lookup);
    if (opts.origin && target.url.origin !== opts.origin) throw new PostingFetchError("다른 사이트로 이동하는 주소는 읽지 않습니다.");
    let res: RawPageResponse;
    try {
      res = await connect(target, { signal, maxBytes: opts.maxBytes, ...(opts.headers ? { headers: opts.headers } : {}) });
    } catch (err) {
      if (err instanceof PostingFetchError) throw err;
      if (deps.signal?.aborted) throw deps.signal.reason ?? err;
      if (timeout.aborted) throw new PostingFetchError("공고 사이트의 응답이 늦습니다. 잠시 후 다시 시도하세요.");
      throw new PostingFetchError("공고 사이트에 연결하지 못했습니다. 링크를 확인하고 잠시 후 다시 시도하세요.");
    }
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.location;
      if (!location || redirects >= MAX_REDIRECTS) {
        throw new PostingFetchError("이동이 반복되는 주소입니다. 최종 공고 상세 주소를 입력하세요.");
      }
      try {
        current = new URL(location, target.url).href;
      } catch {
        throw new PostingFetchError("공고 사이트가 잘못된 주소로 이동시켰습니다. 최종 공고 상세 주소를 입력하세요.");
      }
      continue;
    }
    return { target, res };
  }
}

/** 공고 상세 페이지 HTML. 실패는 PostingFetchError/PostingUrlError(사용자용 문구) 또는 취소(AbortError). */
export async function fetchPostingPage(raw: string, deps: FetchDeps = {}): Promise<{ url: string; html: string }> {
  const { target, res } = await guardedGet(raw, deps, { maxBytes: MAX_PAGE_BYTES });
  const type = res.headers["content-type"] ?? "";
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(type);
  if (res.status < 200 || res.status >= 300) {
    // 봇 차단(보안 검사) 페이지면 본문 붙여넣기를 안내한다. 본문을 못 읽어도 헤더만으로 판단할 수 있는 경우가 있다.
    let html = "";
    if (isHtml) {
      try {
        html = decodeHtml(decompress(res.body, res.headers["content-encoding"]), type);
      } catch {
        html = "";
      }
    }
    if (isBotChallengeResponse({ status: res.status, headers: res.headers, html })) throw postingBlockedError();
    throw new PostingFetchError("공고 사이트가 접근을 허용하지 않거나 공고가 사라졌습니다. 공개된 상세 링크를 확인하세요.");
  }
  if (!isHtml) {
    if (isBotChallengeResponse({ status: res.status, headers: res.headers, html: "" })) throw postingBlockedError();
    throw new PostingFetchError("웹 공고 상세 페이지 링크를 입력하세요. 파일·이미지 링크는 지원하지 않습니다.");
  }
  const body = decompress(res.body, res.headers["content-encoding"]);
  const html = decodeHtml(body, type);
  if (isBotChallengeResponse({ status: res.status, headers: res.headers, html })) throw postingBlockedError();
  return { url: target.url.href, html };
}

export interface PublicResource {
  /** 리다이렉트 뒤 최종 주소. */
  url: string;
  status: number;
  contentType: string;
  /** 2xx일 때만 채운다(그 밖에는 ""). */
  text: string;
}

/**
 * 공고 페이지와 같은 출처의 공개 자원(상세 데이터 API·스크립트 파일) GET 1회 — 데이터 요청(request-data.ts)용.
 * fetchPostingPage와 같은 SSRF 방어(공개 주소·DNS 고정·리다이렉트 재검사)에 더해 리다이렉트도 같은 출처 안에서만 따른다.
 * 쿠키·세션은 보내지 않고 GET만 한다. 2xx가 아니어도 던지지 않고 상태만 돌려준다(다음 후보로 넘어간다).
 * 보안 검사 응답이면 postingBlockedError.
 */
export async function fetchPublicResource(
  raw: string,
  deps: FetchDeps & { accept: string; referer?: string; maxBytes: number },
): Promise<PublicResource> {
  const origin = new URL(raw).origin;
  const { target, res } = await guardedGet(raw, deps, { maxBytes: deps.maxBytes, origin, headers: { accept: deps.accept, referer: deps.referer } });
  const contentType = res.headers["content-type"] ?? "";
  const ok = res.status >= 200 && res.status < 300;
  let text = "";
  if (ok || /text\/html/i.test(contentType)) {
    try {
      text = decodeHtml(decompress(res.body, res.headers["content-encoding"]), contentType);
    } catch {
      text = "";
    }
  }
  if (isBotChallengeResponse({ status: res.status, headers: res.headers, html: /text\/html/i.test(contentType) ? text : "" })) throw postingBlockedError();
  return { url: target.url.href, status: res.status, contentType, text: ok ? text : "" };
}
