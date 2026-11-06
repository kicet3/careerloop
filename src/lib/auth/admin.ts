import "server-only";
/**
 * 회원 관리(관리자 전용) 저장소. 라우트는 requireAdminApiUser()로 관리자를 확인한 뒤 actor로 넘긴다.
 * 규칙: 자기 자신은 바꿀 수 없다 · 관리자(role=admin 또는 ADMIN_EMAILS)는 거절·정지할 수 없다 ·
 * 허용 전이만(allowedAdminActions) · 거절·정지하면 그 사용자의 세션을 모두 지우고 MCP 토큰을 모두 폐기한다.
 * 상태 변경은 조건부 UPDATE(바꾸기 전 상태가 그대로일 때만)라 동시 처리에서 한쪽만 반영된다.
 */
import { prisma, type Prisma } from "@/lib/db/client";
import {
  ADMIN_USER_ACTION_TARGET,
  ADMIN_USER_TAB_STATUSES,
  ADMIN_USER_TABS,
  allowedAdminActions,
  isUserRole,
  isUserStatus,
  type AdminUserAction,
  type AdminUserTab,
  type UserRole,
  type UserStatus,
} from "@/lib/domain/users";
import { isAdminEmail } from "./admin-emails";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  googleLinked: boolean;
  createdAt: number;
  approvedAt: number | null;
  statusChangedAt: number | null;
  lastLoginAt: number | null;
  /** 지금 상태에서 이 관리자가 할 수 있는 동작(자기 자신·관리자 대상 제한 반영). */
  actions: AdminUserAction[];
}

export const ADMIN_USER_PAGE_SIZE = 50;

const select = {
  id: true,
  email: true,
  name: true,
  role: true,
  status: true,
  googleSub: true,
  createdAt: true,
  approvedAt: true,
  statusChangedAt: true,
  lastLoginAt: true,
} satisfies Prisma.UserSelect;

type Row = Prisma.UserGetPayload<{ select: typeof select }>;

/** role=admin, 또는 Google로 확인된(google_sub 있음) ADMIN_EMAILS 계정. 확인 안 된 예전 가입 계정은 보호하지 않는다. */
function isProtectedAdmin(row: { role: string; email: string; googleSub?: string | null }): boolean {
  return row.role === "admin" || (row.googleSub != null && isAdminEmail(row.email));
}

/** actor가 target에게 할 수 있는 동작. */
export function actionsFor(actorId: string, target: { id: string; role: string; email: string; googleSub?: string | null; status: UserStatus }): AdminUserAction[] {
  if (target.id === actorId) return [];
  const actions = allowedAdminActions(target.status);
  return isProtectedAdmin(target) ? actions.filter((a) => a !== "reject" && a !== "suspend") : actions;
}

function toRow(actorId: string, r: Row): AdminUserRow {
  const status: UserStatus = isUserStatus(r.status) ? r.status : "pending";
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: isUserRole(r.role) ? r.role : "user",
    status,
    googleLinked: !!r.googleSub,
    createdAt: r.createdAt.getTime(),
    approvedAt: r.approvedAt?.getTime() ?? null,
    statusChangedAt: r.statusChangedAt?.getTime() ?? null,
    lastLoginAt: r.lastLoginAt?.getTime() ?? null,
    actions: actionsFor(actorId, { ...r, status }),
  };
}

/**
 * 탭별 회원 목록. 승인 대기는 오래된 가입부터, 나머지는 최근 가입부터. q는 이메일·이름 부분 일치(대소문자 무시).
 * offset 페이지(page 0부터) — 회원 수가 작다는 전제.
 */
export async function listUsersForAdmin(
  actorId: string,
  opts: { tab: AdminUserTab; q?: string; page?: number; pageSize?: number },
): Promise<{ users: AdminUserRow[]; total: number }> {
  const q = opts.q?.trim().slice(0, 100);
  const where: Prisma.UserWhereInput = {
    status: { in: [...ADMIN_USER_TAB_STATUSES[opts.tab]] },
    ...(q ? { OR: [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const size = Math.min(Math.max(opts.pageSize ?? ADMIN_USER_PAGE_SIZE, 1), 200);
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      select,
      where,
      orderBy: [{ createdAt: opts.tab === "pending" ? "asc" : "desc" }, { id: "asc" }],
      skip: Math.max(opts.page ?? 0, 0) * size,
      take: size,
    }),
    prisma.user.count({ where }),
  ]);
  return { users: rows.map((r) => toRow(actorId, r)), total };
}

/** 탭별 회원 수(탭 제목 숫자). */
export async function countUsersByTab(): Promise<Record<AdminUserTab, number>> {
  const groups = await prisma.user.groupBy({ by: ["status"], _count: { _all: true } });
  const out = Object.fromEntries(ADMIN_USER_TABS.map((t) => [t, 0])) as Record<AdminUserTab, number>;
  for (const g of groups) {
    for (const t of ADMIN_USER_TABS) {
      if ((ADMIN_USER_TAB_STATUSES[t] as readonly string[]).includes(g.status)) out[t] += g._count._all;
    }
  }
  return out;
}

/** 승인 대기 회원 수(사이드바 배지). */
export async function countPendingUsers(): Promise<number> {
  return prisma.user.count({ where: { status: "pending" } });
}

export type AdminActionResult =
  | { ok: true; user: AdminUserRow }
  | { ok: false; reason: "not_found" | "self" | "target_admin" | "invalid_transition" | "conflict"; message: string };

const MESSAGES = {
  not_found: "회원을 찾을 수 없습니다.",
  self: "자기 계정의 상태는 바꿀 수 없습니다.",
  target_admin: "관리자 계정은 거절·정지할 수 없습니다.",
  invalid_transition: "지금 상태에서는 할 수 없는 동작입니다.",
  conflict: "다른 관리자가 먼저 처리했습니다. 새로고침해 주세요.",
} as const;

const fail = (reason: keyof typeof MESSAGES): AdminActionResult => ({ ok: false, reason, message: MESSAGES[reason] });

/** 승인·거절·정지·정지 해제. HTTP 매핑: not_found 404 · self/target_admin/invalid_transition 400 · conflict 409. */
export async function adminSetUserStatus(actorId: string, targetId: string, action: AdminUserAction): Promise<AdminActionResult> {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select });
  if (!target) return fail("not_found");
  if (target.id === actorId) return fail("self");
  const status: UserStatus = isUserStatus(target.status) ? target.status : "pending";
  if ((action === "reject" || action === "suspend") && isProtectedAdmin(target)) return fail("target_admin");
  if (!allowedAdminActions(status).includes(action)) return fail("invalid_transition");

  const next = ADMIN_USER_ACTION_TARGET[action];
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: targetId, status },
      data: {
        status: next,
        statusChangedAt: now,
        ...(next === "approved" ? { approvedAt: now, approvedBy: actorId } : {}),
      },
    });
    if (count === 0) return null;
    if (next === "rejected" || next === "suspended") {
      await tx.session.deleteMany({ where: { userId: targetId } });
      // MCP 토큰도 폐기한다(정지 해제 뒤에도 다시 쓰이지 않게 — 사용자가 새로 만든다).
      await tx.mcpToken.updateMany({ where: { userId: targetId, revokedAt: null }, data: { revokedAt: now } });
    }
    return tx.user.findUnique({ where: { id: targetId }, select });
  });
  if (!updated) return fail("conflict");
  return { ok: true, user: toRow(actorId, updated) };
}
