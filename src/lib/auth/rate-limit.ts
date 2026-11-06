/**
 * 고정 창(fixed window) 방식의 가벼운 메모리 레이트 리밋.
 * 주의: 서버 인스턴스(프로세스)마다 따로 센다. 여러 인스턴스·서버리스 환경에서는 느슨한 방어일 뿐이다.
 * 짧은 창의 남용 방지(로그인 등)에만 쓰고, 비용이 드는 기능의 긴 창 제한은 DB 원장(db-rate-limit.ts)으로 센다.
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
    /** 기록하지 않고 지금 막혀 있는지만 본다(실패만 세는 리밋이 요청 처리 전에 확인할 때). */
    peek(key: string, now: number = Date.now()): { ok: boolean; retryAfterSec: number } {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) return { ok: true, retryAfterSec: 0 };
      return { ok: entry.count < opts.limit, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}

/**
 * 레이트 리밋 키로 쓸 클라이언트 IP. 클라이언트가 마음대로 넣을 수 있는 값(X-Forwarded-For의 맨 왼쪽)은 믿지 않는다.
 * - Vercel(VERCEL 환경 변수): 플랫폼이 덮어쓰는 x-real-ip.
 * - TRUSTED_PROXY_HOPS=n: 우리 쪽 프록시 n개가 X-Forwarded-For 끝에 붙인 값 중 가장 바깥(오른쪽에서 n번째).
 * - 그 밖: X-Forwarded-For의 맨 오른쪽(가장 가까운 프록시가 붙인 값). 프록시 없이 직접 노출된 서버라면 이 값도
 *   클라이언트가 넣을 수 있으므로 TRUSTED_PROXY_HOPS를 설정한 리버스 프록시 뒤에서 운영해야 한다.
 */
export function clientIp(req: { headers: { get(name: string): string | null } }, env: Record<string, string | undefined> = process.env): string {
  if (env.VERCEL) {
    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real;
  }
  const parts = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const hops = Number(env.TRUSTED_PROXY_HOPS);
  if (parts.length > 0) {
    if (Number.isInteger(hops) && hops > 0) return parts[Math.max(0, parts.length - hops)]!;
    return parts[parts.length - 1]!;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

const globalForLimits = globalThis as unknown as {
  __loginLimiter?: ReturnType<typeof createRateLimiter>;
  __loginIpLimiter?: ReturnType<typeof createRateLimiter>;
  __loginAccountLimiter?: ReturnType<typeof createRateLimiter>;
  __passwordChangeLimiter?: ReturnType<typeof createRateLimiter>;
  __shareLimiter?: ReturnType<typeof createRateLimiter>;
  __googleAuthLimiter?: ReturnType<typeof createRateLimiter>;
};

/** 로그인: 이메일+IP당 15분에 10회. */
export const loginLimiter = (globalForLimits.__loginLimiter ??= createRateLimiter({
  limit: 10,
  windowMs: 15 * 60_000,
}));

/** 로그인: IP당 15분에 30회(이메일을 바꿔 가며 시도해도 막힌다 — bcrypt 비용 남용 방지). */
export const loginIpLimiter = (globalForLimits.__loginIpLimiter ??= createRateLimiter({
  limit: 30,
  windowMs: 15 * 60_000,
}));

/** 로그인 실패: 계정(이메일)당 15분에 20회(IP를 바꿔 가며 한 계정을 노리는 경우). 성공하면 초기화. */
export const loginAccountLimiter = (globalForLimits.__loginAccountLimiter ??= createRateLimiter({
  limit: 20,
  windowMs: 15 * 60_000,
}));

/** 비밀번호 설정·변경: 사용자당 15분에 10회(현재 비밀번호 추측 방지). */
export const passwordChangeLimiter = (globalForLimits.__passwordChangeLimiter ??= createRateLimiter({
  limit: 10,
  windowMs: 15 * 60_000,
}));

/** 공개 공유 링크(페이지·PDF): IP당 1분에 30회. */
export const shareLimiter = (globalForLimits.__shareLimiter ??= createRateLimiter({
  limit: 30,
  windowMs: 60_000,
}));

/** Google 로그인 시작·콜백: IP당 15분에 각각 30회(키에 단계 접두사를 붙여 따로 센다). */
export const googleAuthLimiter = (globalForLimits.__googleAuthLimiter ??= createRateLimiter({
  limit: 30,
  windowMs: 15 * 60_000,
}));
