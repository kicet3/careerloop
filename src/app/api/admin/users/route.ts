import { countUsersByTab, listUsersForAdmin } from "@/lib/auth/admin";
import { requireAdminApiUser } from "@/lib/auth/session";
import { ADMIN_USER_TABS, type AdminUserTab } from "@/lib/domain/users";

/** 회원 목록(관리자). ?tab=pending|approved|blocked&q=&page=(0부터). 응답 { users, total, counts }. */
export async function GET(req: Request) {
  const admin = await requireAdminApiUser();
  if (admin instanceof Response) return admin;
  const sp = new URL(req.url).searchParams;
  const tabParam = sp.get("tab");
  const tab: AdminUserTab = (ADMIN_USER_TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as AdminUserTab) : "pending";
  const page = Math.max(0, Number.parseInt(sp.get("page") ?? "0", 10) || 0);
  const q = sp.get("q") ?? undefined;
  const [list, counts] = await Promise.all([listUsersForAdmin(admin.id, { tab, q, page }), countUsersByTab()]);
  return Response.json({ ...list, counts }, { headers: { "Cache-Control": "no-store" } });
}
