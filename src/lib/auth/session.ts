import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/lib/db/client";
import { appUrl, isProduction, trustedOriginHosts } from "@/lib/config/env";
import { isUserRole, isUserStatus, type UserRole, type UserStatus } from "@/lib/domain/users";
import { getMissingConsents } from "@/lib/legal/service";
import type { ConsentType } from "@/lib/legal/consents";
import { ACCESS_API_ERRORS, accessDecision, accessRedirectPath, type AccessDecision } from "./access";
import { APPROVED_BY_ADMIN_EMAILS, isAdminEmail } from "./admin-emails";
import { safeNextPath } from "./validation";

export const SESSION_COOKIE = "rp_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** 남은 기간이 이보다 짧으면(=발급 후 15일 경과) 30일로 연장한다. */
const SESSION_RENEW_BELOW_MS = 15 * 24 * 60 * 60_000;

export type SessionUser = { id: string; email: string; name: string | null; role: UserRole; status: UserStatus };

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
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({ data: { id: hashToken(token), userId, expiresAt } });
  await prisma.user.updateMany({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  (await cookies()).set(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

/** 현재 세션 행을 지우고 쿠키를 비운다. Route Handler / Server Function에서만 호출. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { id: hashToken(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/** 현재 세션만 남기고 이 사용자의 다른 세션을 모두 지운다(비밀번호 변경 후 다른 기기 로그아웃). */
export async function revokeOtherSessions(userId: string): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await prisma.session.deleteMany({
    where: token ? { userId, id: { not: hashToken(token) } } : { userId },
  });
}

/** 로그인 사용자(요청당 1회 조회). 서버 컴포넌트·라우트 핸들러 양쪽에서 사용 가능. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 128) return null;

  const sessionId = hashToken(token);
  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { expiresAt: true, user: { select: { id: true, email: true, name: true, role: true, status: true, googleSub: true } } },
  });
  if (!row) return null;

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
    return null;
  }

  if (row.expiresAt.getTime() - now < SESSION_RENEW_BELOW_MS) {
    const expiresAt = new Date(now + SESSION_TTL_MS);
    // 서버 컴포넌트 렌더링 중에는 쿠키를 쓸 수 없다(throw). 쿠키를 갱신할 수 있을 때만 DB도 연장한다.
    try {
      store.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
      await prisma.session.updateMany({ where: { id: sessionId }, data: { expiresAt } });
    } catch {
      // 다음 라우트 핸들러 요청에서 연장된다.
    }
  }

  const user: SessionUser = {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: isUserRole(row.user.role) ? row.user.role : "user",
    status: isUserStatus(row.user.status) ? row.user.status : "pending",
  };
  return promoteAdminIfListed(user, row.user.googleSub != null);
});

/**
 * ADMIN_EMAILS에 있는 이메일이면 role=admin·status=approved로 올린다(이미 그렇면 쓰지 않는다).
 * 로그인 직후 첫 요청과 이후 모든 세션 확인에서 돈다 — 목록에 새로 넣은 이메일도 다음 요청부터 적용된다.
 * Google로 이메일 소유가 확인된 계정(google_sub 있음)만 올린다. 예전 이메일·비밀번호 가입은 이메일 소유를 확인하지 않았으므로
 * 같은 주소로 먼저 가입해 둔 사람이 관리자가 되지 않게 한다(진짜 주인이 Google을 연결하면 그때 올라간다).
 */
export async function promoteAdminIfListed(
  user: SessionUser,
  emailVerified: boolean,
  env: Record<string, string | undefined> = process.env,
): Promise<SessionUser> {
  if (!emailVerified || !isAdminEmail(user.email, env) || (user.role === "admin" && user.status === "approved")) return user;
  const now = new Date();
  await prisma.user.updateMany({
    where: { id: user.id },
    data: {
      role: "admin",
      status: "approved",
      ...(user.status !== "approved" ? { approvedAt: now, approvedBy: APPROVED_BY_ADMIN_EMAILS, statusChangedAt: now } : {}),
    },
  });
  return { ...user, role: "admin", status: "approved" };
}

export interface CurrentAccess {
  user: SessionUser;
  decision: AccessDecision;
  /** 현재 버전으로 다시 받아야 하는 필수 동의. */
  missingConsents: ConsentType[];
}

/** 로그인 사용자 + 앱 사용 가능 여부(요청당 1회). 로그인하지 않았으면 null. */
export const getCurrentAccess = cache(async (): Promise<CurrentAccess | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  // 거절·정지는 동의 여부와 무관하게 안내 화면이라 조회를 건너뛴다.
  const missingConsents = user.status === "rejected" || user.status === "suspended" ? [] : await getMissingConsents(user.id);
  return { user, decision: accessDecision(user.status, missingConsents), missingConsents };
});

function loginRedirect(nextPath?: string): never {
  const next = nextPath ? safeNextPath(nextPath) : null;
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
}

/**
 * 페이지용(로그인만 확인): 로그인하지 않았으면 `/login?next=`로 보낸다. 승인 대기·동의 화면(/pending·/consent)처럼
 * 비승인 사용자도 봐야 하는 화면에서만 쓴다. 앱 화면은 requireApprovedUser(=requireUser).
 */
export async function requireSignedInUser(nextPath?: string): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) loginRedirect(nextPath);
  return user;
}

/**
 * 페이지용: 로그인 + 승인됨 + 필수 동의(현재 버전)까지 확인한다. 아니면 /login·/consent·/pending으로 보낸다.
 */
export async function requireApprovedUser(nextPath?: string): Promise<SessionUser> {
  const access = await getCurrentAccess();
  if (!access) loginRedirect(nextPath);
  const to = accessRedirectPath(access.decision, nextPath ? safeNextPath(nextPath) : null);
  if (to) redirect(to);
  return access.user;
}

/** 앱 화면 기본 가드 = requireApprovedUser. 기존 호출부(모든 /app 화면)가 그대로 승인·동의를 확인한다. */
export const requireUser = requireApprovedUser;

/** 페이지용: 승인된 관리자만. 관리자가 아니면 404(관리 화면의 존재를 드러내지 않는다). */
export async function requireAdmin(nextPath?: string): Promise<SessionUser> {
  const user = await requireApprovedUser(nextPath);
  if (user.role !== "admin") notFound();
  return user;
}

const unauthorized = () => Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

/** API용(로그인만 확인): 동의 제출·탈퇴·승인 상태 조회처럼 비승인 사용자도 불러야 하는 API에서만 쓴다. */
export async function requireSignedInApiUser(): Promise<SessionUser | Response> {
  return (await getCurrentUser()) ?? unauthorized();
}

/**
 * API용: 로그인 + 승인됨 + 필수 동의. 로그인 안 함 → 401, 그 밖 → 403 { error, code }
 * (code: consent_required | approval_pending | account_rejected | account_suspended).
 */
export async function requireApprovedApiUser(): Promise<SessionUser | Response> {
  const access = await getCurrentAccess();
  if (!access) return unauthorized();
  if (access.decision !== "ok") return Response.json(ACCESS_API_ERRORS[access.decision], { status: 403 });
  return access.user;
}

/**
 * API 기본 가드 = requireApprovedApiUser. 기존 호출부(LLM·가져오기·그래프 쓰기 등 모든 앱 API)가 그대로
 * 승인·동의를 확인한다(실패 시 닫힘).
 */
export const requireApiUser = requireApprovedApiUser;

/** API용: 승인된 관리자만. 관리자가 아니면 403. */
export async function requireAdminApiUser(): Promise<SessionUser | Response> {
  const user = await requireApprovedApiUser();
  if (user instanceof Response) return user;
  if (user.role !== "admin") return Response.json({ error: "관리자만 할 수 있습니다.", code: "admin_only" }, { status: 403 });
  return user;
}

/** 이 사용자의 모든 세션을 지운다(정지·거절·탈퇴). */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
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
