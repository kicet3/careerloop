import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";
import { appUrl, isProduction, trustedOriginHosts } from "@/lib/config/env";
import { safeNextPath } from "./validation";

export const SESSION_COOKIE = "rp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** 남은 기간이 이보다 짧으면(=발급 후 15일 경과) 30일로 연장한다. */
const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60_000;

export type SessionUser = { id: string; email: string; name: string | null };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 세션 쿠키 Secure 여부. APP_ENV=PRODUCTION이면 항상, DEV면 프로덕션 빌드(next start)일 때만. */
export function sessionCookieSecure(env: Record<string, string | undefined> = process.env): boolean {
  return isProduction(env) || env.NODE_ENV === "production";
}

function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: sessionCookieSecure(),
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

/** 현재 세션만 남기고 이 사용자의 다른 세션을 모두 지운다(비밀번호 변경 후 다른 기기 로그아웃). */
export async function revokeOtherSessions(userId: string): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await ensureDatabase();
  const where = token
    ? and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, hashToken(token)))
    : eq(schema.sessions.userId, userId);
  await db.delete(schema.sessions).where(where);
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
 * APP_ENV=PRODUCTION이면 Host·X-Forwarded-Host 헤더(클라이언트·프록시가 바꿀 수 있음)를 믿지 않고 앱 주소(APP_URL, 없으면 Vercel 배포 주소)
 * 호스트만 허용한다.
 */
export function assertSameOrigin(req: Request, env: Record<string, string | undefined> = process.env): Response | null {
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
  if (isProduction(env)) {
    // 시작 시 검사(validateProductionEnv)로 https 앱 주소가 보장된다(Vercel Preview는 그 배포 주소도). 없으면 모두 거부.
    for (const h of trustedOriginHosts(env)) allowed.add(h);
    return allowed.has(originHost) ? null : forbidden();
  }
  const host = req.headers.get("host");
  if (host) allowed.add(host);
  const fwdHost = req.headers.get("x-forwarded-host");
  if (fwdHost) allowed.add(fwdHost.split(",")[0]!.trim());
  try {
    allowed.add(new URL(req.url).host);
  } catch {}
  const configured = appUrl(env);
  if (configured) {
    try {
      allowed.add(new URL(configured).host);
    } catch {}
  }
  return allowed.has(originHost) ? null : forbidden();
}
