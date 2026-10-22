import { eq } from "drizzle-orm";
import { authError, readJson } from "@/lib/auth/http";
import { verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { clientIp, loginLimiter } from "@/lib/auth/rate-limit";
import { assertSameOrigin, createSession } from "@/lib/auth/session";
import { LoginInputSchema, toFieldErrors } from "@/lib/auth/validation";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";

const INVALID = "이메일 또는 비밀번호가 올바르지 않습니다.";

export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;

  const parsed = LoginInputSchema.safeParse(await readJson(req));
  if (!parsed.success) return authError(400, "입력값을 확인해 주세요.", toFieldErrors(parsed.error));
  const { email, password } = parsed.data;

  // 인스턴스별 메모리 카운터(rate-limit.ts 참고)
  const limitKey = `${email}|${clientIp(req)}`;
  const limit = loginLimiter.hit(limitKey);
  if (!limit.ok) {
    return authError(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.", undefined, {
      "Retry-After": String(limit.retryAfterSec),
    });
  }

  await ensureDatabase();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummy(password);
  if (!user || !ok) return authError(401, INVALID);

  loginLimiter.reset(limitKey);
  await createSession(user.id);
  return Response.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
}
