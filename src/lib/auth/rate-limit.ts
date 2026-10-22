/**
 * 고정 창(fixed window) 방식의 가벼운 메모리 레이트 리밋.
 * 주의: 서버 인스턴스(프로세스)마다 따로 센다. 여러 인스턴스·서버리스 환경에서는 느슨한 방어일 뿐이다.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; maxKeys?: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const maxKeys = opts.maxKeys ?? 10_000;

  function sweep(now: number) {
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }

  return {
    /** 시도 1회를 기록하고 허용 여부를 돌려준다. */
    hit(key: string, now: number = Date.now()): { ok: boolean; retryAfterSec: number } {
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        if (hits.size >= maxKeys) sweep(now);
        entry = { count: 0, resetAt: now + opts.windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { ok: entry.count <= opts.limit, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

const globalForLimits = globalThis as unknown as {
  __loginLimiter?: ReturnType<typeof createRateLimiter>;
  __signupLimiter?: ReturnType<typeof createRateLimiter>;
};

/** 로그인: 이메일+IP당 15분에 10회. */
export const loginLimiter = (globalForLimits.__loginLimiter ??= createRateLimiter({
  limit: 10,
  windowMs: 15 * 60_000,
}));

/** 가입: IP당 1시간에 10회. */
export const signupLimiter = (globalForLimits.__signupLimiter ??= createRateLimiter({
  limit: 10,
  windowMs: 60 * 60_000,
}));
