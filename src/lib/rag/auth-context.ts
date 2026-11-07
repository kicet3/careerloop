import "server-only";
/**
 * 인증 컨텍스트(§3). userId는 라우트가 세션(또는 MCP 토큰 행)에서 꺼낸 값만 받는다 — 도구 인자에는 범위 필드가 없다.
 * after() 안에서 부르므로 쿠키·React cache를 쓰지 않고 DB를 직접 읽어 사용자 상태·필수 동의를 다시 확인한다.
 * 컨텍스트는 함수 인자로만 전달한다(모듈 전역·AsyncLocalStorage에 두지 않는다).
 */
import { nanoid } from "nanoid";
import { accessDecision } from "@/lib/auth/access";
import { prisma } from "@/lib/db/client";
import { isUserStatus } from "@/lib/domain/users";
import { getMissingConsents } from "@/lib/legal/service";
import { AccessRevokedError, PolicyChangedError } from "./errors";
import { readRagState } from "./versions";

export interface AuthContext {
  readonly principalUserId: string;
  /** 단일 사용자 테넌시: principalUserId와 같다(확장 자리). */
  readonly tenantId: string;
  readonly requestId: string;
  readonly policyVersion: number;
  readonly dataVersion: bigint;
  readonly sourceVersion: bigint;
  readonly indexedSourceVersion: bigint;
  readonly startedAt: number;
}

async function assertAccess(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (!user) throw new AccessRevokedError();
  const status = isUserStatus(user.status) ? user.status : "pending";
  const missing = status === "rejected" || status === "suspended" ? [] : await getMissingConsents(userId);
  if (accessDecision(status, missing) !== "ok") throw new AccessRevokedError();
}

export async function createAuthContext(userId: string, opts: { now?: number } = {}): Promise<AuthContext> {
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 128) throw new AccessRevokedError();
  await assertAccess(userId);
  const state = await readRagState(userId);
  return Object.freeze({
    principalUserId: userId,
    tenantId: userId,
    requestId: nanoid(16),
    policyVersion: state.policyVersion,
    dataVersion: state.dataVersion,
    sourceVersion: state.sourceVersion,
    indexedSourceVersion: state.indexedSourceVersion,
    startedAt: opts.now ?? Date.now(),
  });
}

/** 루프의 매 스텝 전: 권한 버전 1행 + 사용자 상태. 바뀌었으면 PolicyChangedError(LLM 추가 호출 없음). */
export async function assertPolicyCurrent(ctx: AuthContext): Promise<void> {
  const state = await readRagState(ctx.principalUserId);
  if (state.policyVersion !== ctx.policyVersion) throw new PolicyChangedError();
  const user = await prisma.user.findUnique({ where: { id: ctx.principalUserId }, select: { status: true } });
  if (!user || user.status !== "approved") throw new PolicyChangedError();
}

/** 최종 검증 직전: 권한이 바뀌었으면 중단, 데이터가 바뀌었으면 stale(권위 레코드 재조회로 다시 확인한다). */
export async function assertContextCurrent(ctx: AuthContext): Promise<{ dataChanged: boolean }> {
  await assertPolicyCurrent(ctx);
  const state = await readRagState(ctx.principalUserId);
  return { dataChanged: state.dataVersion !== ctx.dataVersion };
}
