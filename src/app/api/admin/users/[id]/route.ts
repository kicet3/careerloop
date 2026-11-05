import { z } from "zod";
import { adminSetUserStatus } from "@/lib/auth/admin";
import { authError, readJson } from "@/lib/auth/http";
import { assertSameOrigin, requireAdminApiUser } from "@/lib/auth/session";
import { ADMIN_USER_ACTIONS } from "@/lib/domain/users";

type Ctx = { params: Promise<{ id: string }> };

const ActionInputSchema = z.object({ action: z.enum(ADMIN_USER_ACTIONS) });

const STATUS_BY_REASON = { not_found: 404, self: 400, target_admin: 400, invalid_transition: 400, conflict: 409 } as const;

/** 회원 상태 변경(관리자). 본문 { action: approve|reject|suspend|unsuspend }. 거절·정지는 그 회원의 세션을 모두 끊는다. */
export async function PATCH(req: Request, { params }: Ctx) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const admin = await requireAdminApiUser();
  if (admin instanceof Response) return admin;
  const parsed = ActionInputSchema.safeParse(await readJson(req));
  if (!parsed.success) return authError(400, "알 수 없는 동작입니다.");
  const { id } = await params;
  const result = await adminSetUserStatus(admin.id, id, parsed.data.action);
  if (!result.ok) return Response.json({ error: result.message, code: result.reason }, { status: STATUS_BY_REASON[result.reason] });
  return Response.json({ user: result.user });
}
