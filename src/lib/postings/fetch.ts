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
import { parsePostingUrl } from "./url";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 3;

/** 사용자에게 그대로 보여도 되는 가져오기 실패(내부 주소·원본 오류는 담지 않는다). */
export class PostingFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingFetchError";
  }
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
  opts: { signal: AbortSignal; maxBytes: number },
) => Promise<RawPageResponse>;

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
const nodeConnect: ConnectFn = ({ url, address }, { signal, maxBytes }) =>
  new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(
      url,
      {
        agent: false,
        signal,
        headers: {
          "user-agent": "ResumePanel/1.0 (job posting reader)",
          accept: "text/html,application/xhtml+xml",
          "accept-encoding": "gzip, deflate, br",
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

/** 공고 상세 페이지 HTML. 실패는 PostingFetchError/PostingUrlError(사용자용 문구) 또는 취소(AbortError). */
export async function fetchPostingPage(raw: string, deps: FetchDeps = {}): Promise<{ url: string; html: string }> {
  const lookup = deps.lookup ?? defaultLookup;
  const connect = deps.connect ?? nodeConnect;
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;

  let current = raw;
  for (let redirects = 0; ; redirects++) {
    const target = await publicTarget(current, lookup);
    let res: RawPageResponse;
    try {
      res = await connect(target, { signal, maxBytes: MAX_PAGE_BYTES });
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
    if (res.status < 200 || res.status >= 300) {
      throw new PostingFetchError("공고 사이트가 접근을 허용하지 않거나 공고가 사라졌습니다. 공개된 상세 링크를 확인하세요.");
    }
    const type = res.headers["content-type"] ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      throw new PostingFetchError("웹 공고 상세 페이지 링크를 입력하세요. 파일·이미지 링크는 지원하지 않습니다.");
    }
    const body = decompress(res.body, res.headers["content-encoding"]);
    return { url: target.url.href, html: decodeHtml(body, type) };
  }
}
