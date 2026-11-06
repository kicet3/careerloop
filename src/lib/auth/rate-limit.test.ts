import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("창 안에서 limit 초과 시 거부, 창이 지나면 초기화", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.hit("k", 0).ok).toBe(true);
    expect(rl.hit("k", 10).ok).toBe(true);
    const third = rl.hit("k", 20);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBe(1);
    expect(rl.hit("other", 20).ok).toBe(true);
    expect(rl.hit("k", 1000).ok).toBe(true);
  });

  it("reset", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000 });
    rl.hit("k", 0);
    expect(rl.hit("k", 1).ok).toBe(false);
    rl.reset("k");
    expect(rl.hit("k", 2).ok).toBe(true);
  });

  it("peek은 세지 않고 막혔는지만 본다", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect(rl.peek("k", 0)).toEqual({ ok: true, retryAfterSec: 0 });
    rl.hit("k", 0);
    expect(rl.peek("k", 1).ok).toBe(true);
    rl.hit("k", 2);
    expect(rl.peek("k", 3)).toEqual({ ok: false, retryAfterSec: 1 });
    expect(rl.peek("k", 1000).ok).toBe(true);
  });
});

describe("clientIp", () => {
  const req = (h: Record<string, string>) => new Request("http://x", { headers: h });

  it("X-Forwarded-For의 맨 왼쪽(클라이언트가 넣을 수 있는 값)을 믿지 않는다", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" }), {})).toBe("10.0.0.1");
  });

  it("TRUSTED_PROXY_HOPS=n이면 오른쪽에서 n번째", () => {
    const r = req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.1" });
    expect(clientIp(r, { TRUSTED_PROXY_HOPS: "2" })).toBe("203.0.113.9");
    expect(clientIp(r, { TRUSTED_PROXY_HOPS: "9" })).toBe("6.6.6.6");
  });

  it("Vercel에서는 플랫폼이 넣는 x-real-ip", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "198.51.100.7" }), { VERCEL: "1" })).toBe("198.51.100.7");
  });

  it("헤더가 없으면 unknown", () => {
    expect(clientIp(req({}), {})).toBe("unknown");
  });
});
