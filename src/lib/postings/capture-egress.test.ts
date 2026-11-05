import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createHostGuard, isAllowedBrowserUrl, parseAuthority, startEgressProxy } = await import("./capture-egress");

const fakeDns: Record<string, string[]> = {
  "public.example": ["93.184.216.34"],
  "rebind.example": ["93.184.216.34", "127.0.0.1"],
  "intranet.example": ["10.0.0.5"],
  "tail.example": ["100.100.1.1"],
  "ula.example": ["fd00::1"],
};
const lookup = vi.fn(async (host: string) => {
  const hit = fakeDns[host];
  if (!hit) throw new Error("ENOTFOUND");
  return hit.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
});

describe("createHostGuard", () => {
  it("공개 주소만 허용하고 호스트별로 한 번만 묻는다", async () => {
    lookup.mockClear();
    const guard = createHostGuard(lookup);
    expect(await guard("public.example")).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await guard("PUBLIC.example.")).toEqual({ address: "93.184.216.34", family: 4 });
    expect(lookup).toHaveBeenCalledTimes(1);
    for (const h of ["rebind.example", "intranet.example", "tail.example", "ula.example", "missing.example", "localhost", "a.localhost"]) {
      expect(await guard(h)).toBeNull();
    }
  });
  it("IP 그대로: 사설·루프백·CGNAT·링크로컬·ULA 거절", async () => {
    const guard = createHostGuard(lookup);
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "100.64.0.1", "169.254.169.254", "0.0.0.0", "[::1]", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
      expect(await guard(ip)).toBeNull();
    }
    expect(await guard("8.8.8.8")).not.toBeNull();
    expect(await guard("[2606:4700::1111]")).not.toBeNull();
  });
});

describe("isAllowedBrowserUrl", () => {
  const guard = createHostGuard(lookup);
  it.each([
    ["https://public.example/jobs/1", true],
    ["http://public.example/", true],
    ["data:image/png;base64,AAAA", true],
    ["about:blank", true],
    ["https://public.example:8443/x", false],
    ["https://user:pw@public.example/", false],
    ["https://intranet.example/", false],
    ["http://169.254.169.254/latest/meta-data", false],
    ["http://localhost:3000/api", false],
    ["file:///etc/passwd", false],
    ["chrome://settings", false],
    ["ftp://public.example/", false],
    ["not a url", false],
  ])("%s → %s", async (url, ok) => {
    expect(await isAllowedBrowserUrl(url, guard)).toBe(ok);
  });
});

describe("parseAuthority", () => {
  it("host:port와 [v6]:port", () => {
    expect(parseAuthority("a.com:443")).toEqual({ host: "a.com", port: 443 });
    expect(parseAuthority("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(parseAuthority("a.com")).toBeNull();
    expect(parseAuthority("a.com:99999")).toBeNull();
  });
});

describe("startEgressProxy", () => {
  // 업스트림: 진짜 공개 서버 대신 로컬 서버로 잇되, 프록시가 '검사한 IP'로 연결하는지 connect 주입으로 확인한다.
  let upstream: http.Server;
  let upstreamPort = 0;
  const dialed: { host: string; port: number }[] = [];
  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.url === "/big" ? "x".repeat(5000) : `ok ${req.headers.host}${req.url}`);
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  const connect = (o: { host: string; port: number }) => {
    dialed.push({ host: o.host, port: o.port });
    return net.connect({ host: "127.0.0.1", port: upstreamPort });
  };

  function viaProxy(proxyPort: number, opts: http.RequestOptions): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, ...opts }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  function connectVia(proxyPort: number, authority: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority });
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
  }

  it("평문 HTTP: 공개 호스트는 검사한 IP로 전달, 내부 주소·다른 포트는 403", async () => {
    const proxy = await startEgressProxy({ guard: createHostGuard(lookup), maxTransferBytes: 1_000_000, connect });
    try {
      dialed.length = 0;
      const ok = await viaProxy(proxy.port, { path: "http://public.example/jobs/1" });
      expect(ok).toEqual({ status: 200, body: "ok public.example/jobs/1" });
      expect(dialed).toEqual([{ host: "93.184.216.34", port: 80 }]);
      expect((await viaProxy(proxy.port, { path: "http://intranet.example/" })).status).toBe(403);
      expect((await viaProxy(proxy.port, { path: "http://rebind.example/" })).status).toBe(403);
      expect((await viaProxy(proxy.port, { path: "http://127.0.0.1/" })).status).toBe(403);
      expect((await viaProxy(proxy.port, { path: "http://public.example:8080/" })).status).toBe(403);
      expect(dialed).toHaveLength(1);
      expect(proxy.blocked()).toBe(4);
    } finally {
      await proxy.close();
    }
  });

  it("CONNECT: 443의 공개 호스트만 터널, 그 밖은 403", async () => {
    const proxy = await startEgressProxy({ guard: createHostGuard(lookup), maxTransferBytes: 1_000_000, connect });
    try {
      dialed.length = 0;
      expect(await connectVia(proxy.port, "public.example:443")).toBe(200);
      expect(dialed).toEqual([{ host: "93.184.216.34", port: 443 }]);
      expect(await connectVia(proxy.port, "intranet.example:443")).toBe(403);
      expect(await connectVia(proxy.port, "169.254.169.254:443")).toBe(403);
      expect(await connectVia(proxy.port, "public.example:22")).toBe(403);
      expect(await connectVia(proxy.port, "[::1]:443")).toBe(403);
      expect(dialed).toHaveLength(1);
    } finally {
      await proxy.close();
    }
  });

  it("전송량 상한을 넘으면 이후 요청을 거절한다", async () => {
    const proxy = await startEgressProxy({ guard: createHostGuard(lookup), maxTransferBytes: 1000, connect });
    try {
      await viaProxy(proxy.port, { path: "http://public.example/big" }).catch(() => null);
      expect(proxy.overLimit()).toBe(true);
      expect((await viaProxy(proxy.port, { path: "http://public.example/" })).status).toBe(509);
      expect(await connectVia(proxy.port, "public.example:443")).toBe(509);
    } finally {
      await proxy.close();
    }
  });
});
