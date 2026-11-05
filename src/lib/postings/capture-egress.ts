import "server-only";
/**
 * 캡처용 헤드리스 브라우저의 네트워크 출구(SSRF 방어). 브라우저는 모든 요청을 이 프로세스 안의 HTTP 프록시
 * (127.0.0.1 임의 포트, --proxy-server + --proxy-bypass-list=<-loopback>)로만 내보내고, 프록시가 fetch.ts와 같은 규칙으로
 * 대상 호스트를 확인한 뒤 '검사한 IP'로만 소켓을 연다 — 브라우저 쪽 DNS 응답을 바꾸는 리바인딩이 통하지 않는다.
 *
 * - 허용: http(80)·https(443)·ws/wss(같은 포트, HTTPS는 CONNECT 터널). 다른 포트·사설/루프백/CGNAT/ULA/링크로컬 주소는 403.
 * - 호스트 이름의 DNS 응답 중 하나라도 공개 주소가 아니면 거절(fetch.ts publicTarget과 같은 규칙). 결과는 호스트별로 캐시.
 * - 응답 바이트 합계가 maxTransferBytes를 넘으면 이후 연결을 모두 끊고 새 연결을 거절한다.
 * 브라우저 쪽 요청 가로채기(capture.ts)는 이 프록시 앞의 1차 거름망이다(스킴·호스트를 미리 걸러 불필요한 연결을 줄인다).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net, { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isPublicAddress, type LookupFn, type ResolvedAddress } from "./fetch";

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

/** 브라우저가 열 수 있는 포트(기본 포트만 — 공고 페이지·CDN은 여기서 충분하다). */
export const CAPTURE_ALLOWED_PORTS = new Set([80, 443]);

/** 호스트 이름 → 공개 주소(첫 번째) 또는 null(거절). 같은 캡처 안에서 호스트별로 한 번만 묻는다. */
export type HostGuard = (hostname: string) => Promise<ResolvedAddress | null>;

export function createHostGuard(lookup: LookupFn = defaultLookup): HostGuard {
  const cache = new Map<string, Promise<ResolvedAddress | null>>();
  return (raw) => {
    const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    let hit = cache.get(host);
    if (!hit) {
      hit = (async () => {
        if (!host || host === "localhost" || host.endsWith(".localhost")) return null;
        const family = isIP(host);
        if (family) return isPublicAddress(host) ? { address: host, family } : null;
        try {
          const addresses = await lookup(host);
          if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) return null;
          return addresses[0]!;
        } catch {
          return null;
        }
      })();
      cache.set(host, hit);
    }
    return hit;
  };
}

/**
 * 브라우저 요청 URL 1차 판정(요청 가로채기용). 네트워크를 쓰지 않는 data:·blob:·about:은 허용,
 * http/https는 사용자 정보가 없고 기본 포트이며 호스트가 공개 주소로 풀릴 때만 허용. 그 밖의 스킴은 거절.
 */
export async function isAllowedBrowserUrl(raw: string, guard: HostGuard): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!CAPTURE_ALLOWED_PORTS.has(port)) return false;
  return (await guard(url.hostname)) !== null;
}

/** "host:port" 또는 "[v6]:port" → {host, port}. 형식이 틀리면 null. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(authority.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: (m[1] ?? m[2])!, port };
}

export interface EgressProxy {
  /** 브라우저 --proxy-server 값. */
  readonly proxyUrl: string;
  readonly port: number;
  /** 지금까지 받은 응답 바이트(헤더 포함 근사). */
  transferred(): number;
  /** 막은 연결 수(진단용). */
  blocked(): number;
  /** 전송량 상한을 넘었는가. */
  overLimit(): boolean;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  guard: HostGuard;
  maxTransferBytes: number;
  /** 업스트림 연결 마감(ms). */
  connectTimeoutMs?: number;
  /** 테스트용: 업스트림 소켓을 여는 함수(기본 net.connect). */
  connect?: (opts: { host: string; port: number; servername: string }) => Duplex;
}

const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer"]);

/** 127.0.0.1의 임의 포트에서 프록시를 연다. 캡처가 끝나면 close()로 닫는다. */
export async function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
  const sockets = new Set<Duplex>();
  let bytes = 0;
  let blockedCount = 0;
  let limited = false;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const track = <T extends Duplex>(s: T): T => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
    return s;
  };
  const count = (n: number) => {
    bytes += n;
    if (!limited && bytes > opts.maxTransferBytes) {
      limited = true;
      for (const s of sockets) s.destroy();
    }
  };
  const openUpstream = (address: ResolvedAddress, port: number, servername: string): Duplex =>
    opts.connect ? opts.connect({ host: address.address, port, servername }) : net.connect({ host: address.address, port, family: address.family });

  const server = http.createServer();
  server.on("connection", (s) => track(s));

  // HTTPS·WSS: CONNECT host:443 → 검사한 IP로 TCP 터널(TLS는 브라우저와 원 서버 사이 — SNI·인증서 확인은 원래 호스트 이름).
  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const target = parseAuthority(req.url ?? "");
    const deny = (status = "403 Forbidden") => {
      blockedCount++;
      client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    if (limited) return deny("509 Bandwidth Limit Exceeded");
    if (!target || !CAPTURE_ALLOWED_PORTS.has(target.port)) return deny();
    void opts.guard(target.host).then((address) => {
      if (!address || limited || client.destroyed) return deny();
      const upstream = track(openUpstream(address, target.port, target.host));
      const timer = setTimeout(() => upstream.destroy(), connectTimeoutMs);
      upstream.once("connect", () => {
        clearTimeout(timer);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.on("data", (chunk: Buffer) => count(chunk.length));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once("error", () => {
        clearTimeout(timer);
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      });
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    });
  });

  // 평문 HTTP: 절대 URI 요청(GET http://host/path)을 검사한 IP로 전달한다. 응답은 그대로 흘려보낸다.
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const deny = (status: number) => {
      blockedCount++;
      res.writeHead(status, { "content-length": "0", connection: "close" }).end();
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return deny(400);
    }
    const port = url.port ? Number(url.port) : 80;
    if (limited) return deny(509);
    if (url.protocol !== "http:" || url.username || url.password || !CAPTURE_ALLOWED_PORTS.has(port)) return deny(403);
    void opts.guard(url.hostname).then((address) => {
      if (!address || limited) return deny(403);
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
      headers.host = url.host;
      headers.connection = "close";
      const upstream = http.request({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        // agent를 주지 않아야 createConnection(검사한 IP로 여는 소켓)을 쓴다. host·port도 검사한 IP로 둔다(이중 안전).
        host: address.address,
        port,
        family: address.family,
        timeout: connectTimeoutMs,
        createConnection: () => track(openUpstream(address, port, url.hostname)) as net.Socket,
      });
      upstream.on("response", (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out);
        up.on("data", (chunk: Buffer) => count(chunk.length));
        up.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-length": "0", connection: "close" }).end();
        else res.destroy();
      });
      req.pipe(upstream);
    });
  });

  // 웹소켓(ws://) 업그레이드: 평문 업그레이드는 터널처럼 검사 후 그대로 잇는다.
  server.on("upgrade", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      client.destroy();
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    if (limited || !/^(http|ws):$/.test(url.protocol) || !CAPTURE_ALLOWED_PORTS.has(port)) {
      blockedCount++;
      client.destroy();
      return;
    }
    void opts.guard(url.hostname).then((address) => {
      if (!address || limited) {
        blockedCount++;
        client.destroy();
        return;
      }
      const upstream = track(openUpstream(address, port, url.hostname));
      upstream.once("connect", () => {
        const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i]!;
          if (k.toLowerCase().startsWith("proxy-")) continue;
          lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.on("data", (chunk: Buffer) => count(chunk.length));
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once("close", () => client.destroy());
      client.once("close", () => upstream.destroy());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    port,
    transferred: () => bytes,
    blocked: () => blockedCount,
    overLimit: () => limited,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
