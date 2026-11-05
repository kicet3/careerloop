import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { authError, readJson } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { clientIp, signupLimiter } from "@/lib/auth/rate-limit";
import { assertSameOrigin, createSession } from "@/lib/auth/session";
import { SignupInputSchema, toFieldErrors } from "@/lib/auth/validation";
import { passwordLoginEnabled } from "@/lib/config/env";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";

// 계정 존재 여부를 직접 드러내지 않는 문구
const CANNOT_SIGNUP = "이 이메일로는 가입할 수 없습니다. 이미 계정이 있다면 로그인해 주세요.";

export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  if (!passwordLoginEnabled()) return authError(403, "이메일 가입은 사용할 수 없습니다. Google로 계속해 주세요.");

  const limit = signupLimiter.hit(clientIp(req));
  if (!limit.ok) {
    return authError(429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", undefined, {
      "Retry-After": String(limit.retryAfterSec),
    });
  }

  const parsed = SignupInputSchema.safeParse(await readJson(req));
  if (!parsed.success) return authError(400, "입력값을 확인해 주세요.", toFieldErrors(parsed.error));
  const { email, password, name } = parsed.data;

  await ensureDatabase();
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (existing.length > 0) return authError(409, CANNOT_SIGNUP);

  const id = nanoid();
  try {
    await db.insert(schema.users).values({ id, email, name, passwordHash: await hashPassword(password) });
  } catch {
    // 동시 가입으로 unique 제약에 걸린 경우
    return authError(409, CANNOT_SIGNUP);
  }

  await createSession(id);
  return Response.json({ ok: true, user: { id, email, name } }, { status: 201 });
}
