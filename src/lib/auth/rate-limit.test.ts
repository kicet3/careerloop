import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

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
});
