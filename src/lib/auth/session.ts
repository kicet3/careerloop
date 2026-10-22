import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";
import { safeNextPath } from "./validation";

export const SESSION_COOKIE = "rp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** 남은 기간이 이보다 짧으면(=발급 후 15일 경과) 30일로 연장한다. */
const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60_000;

export type SessionUser = { id: string; email: string; name: string | null };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** 세션을 만들고 쿠키를 심는다. Route Handler / Server Function에서만 호출. */
export async function createSession(userId: string): Promise<void> {
  await ensureDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ id: hashToken(token), userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

/** 현재 세션 행을 지우고 쿠키를 비운다. Route Handler / Server Function에서만 호출. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await ensureDatabase();
    await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
}

/** 로그인 사용자(요청당 1회 조회). 서버 컴포넌트·라우트 핸들러 양쪽에서 사용 가능. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 128) return null;

  await ensureDatabase();
  const sessionId = hashToken(token);
  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    return null;
  }

  if (row.expiresAt.getTime() - now < SESSION_RENEW_BELOW_MS) {
    const expiresAt = new Date(now + SESSION_TTL_MS);
    // 서버 컴포넌트 렌더링 중에는 쿠키를 쓸 수 없다(throw). 쿠키를 갱신할 수 있을 때만 DB도 연장한다.
    try {
      store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
      await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, sessionId));
    } catch {
      // 다음 라우트 핸들러 요청에서 연장된다.
    }
  }

  return { id: row.id, email: row.email, name: row.name };
});

/** 페이지용: 로그인하지 않았으면 `/login?next=`로 보낸다. */
export async function requireUser(nextPath?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    const next = nextPath ? safeNextPath(nextPath) : null;
    redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  }
  return user;
}

/** API용: 로그인하지 않았으면 401 JSON Response를 돌려준다. */
export async function requireApiUser(): Promise<SessionUser | Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  return user;
}

/**
 * 상태 변경 요청의 same-origin 확인(CSRF 방어). 위반이면 403 Response, 통과면 null.
 * Origin이 없는 요청(브라우저가 아닌 클라이언트)은 Sec-Fetch-Site가 cross-site가 아니면 통과시킨다.
 */
export function assertSameOrigin(req: Request): Response | null {
  const forbidden = () => Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 });
  const origin = req.headers.get("origin");
  if (!origin) {
    return req.headers.get("sec-fetch-site") === "cross-site" ? forbidden() : null;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return forbidden();
  }
  const allowed = new Set<string>();
  const host = req.headers.get("host");
  if (host) allowed.add(host);
  const fwdHost = req.headers.get("x-forwarded-host");
  if (fwdHost) allowed.add(fwdHost.split(",")[0]!.trim());
  try {
    allowed.add(new URL(req.url).host);
  } catch {}
  if (process.env.APP_URL) {
    try {
      allowed.add(new URL(process.env.APP_URL).host);
    } catch {}
  }
  return allowed.has(originHost) ? null : forbidden();
}
