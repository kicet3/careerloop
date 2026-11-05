import { eq } from "drizzle-orm";
import { authError, readJson } from "@/lib/auth/http";
import { verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { clientIp, loginAccountLimiter, loginIpLimiter, loginLimiter } from "@/lib/auth/rate-limit";
import { assertSameOrigin, createSession } from "@/lib/auth/session";
import { LoginInputSchema, toFieldErrors } from "@/lib/auth/validation";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";

const INVALID = "이메일 또는 비밀번호가 올바르지 않습니다.";

/**
 * 이메일·비밀번호 로그인(가입은 Google로만). Google로 가입한 뒤 설정 > 계정에서 비밀번호를 정한 사용자만 쓸 수 있다.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;

  const parsed = LoginInputSchema.safeParse(await readJson(req));
  if (!parsed.success) return authError(400, "입력값을 확인해 주세요.", toFieldErrors(parsed.error));
  const { email, password } = parsed.data;

  // 인스턴스별 메모리 카운터(rate-limit.ts 참고). IP 단독·계정 단독·둘의 조합을 모두 센다.
  const ip = clientIp(req);
  const limitKey = `${email}|${ip}`;
  for (const limit of [loginIpLimiter.hit(ip), loginLimiter.hit(limitKey), loginAccountLimiter.hit(email)]) {
    if (!limit.ok) {
      return authError(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", undefined, {
        "Retry-After": String(limit.retryAfterSec),
      });
    }
  }

  await ensureDatabase();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  // 비밀번호를 아직 설정하지 않은 Google 계정(password_hash null)도 없는 계정과 같은 시간·같은 응답으로 거절한다.
  const ok = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
  if (!user || !ok) return authError(401, INVALID);

  loginLimiter.reset(limitKey);
  loginAccountLimiter.reset(email);
  await createSession(user.id);
  return Response.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
}
