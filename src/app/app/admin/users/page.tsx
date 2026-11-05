import type { Metadata } from "next";
import Link from "next/link";
import { AdminUserActions } from "@/components/admin/AdminUserActions";
import { formatDateTime } from "@/components/app/stages";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { ADMIN_USER_PAGE_SIZE, countUsersByTab, listUsersForAdmin } from "@/lib/auth/admin";
import { requireAdmin } from "@/lib/auth/session";
import { ADMIN_USER_TAB_LABELS, ADMIN_USER_TABS, USER_STATUS_LABELS, type AdminUserTab, type UserStatus } from "@/lib/domain/users";

export const metadata: Metadata = { title: "회원 관리" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<UserStatus, BadgeTone> = {
  pending: "warning",
  approved: "positive",
  rejected: "neutral",
  suspended: "negative",
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function hrefFor(tab: AdminUserTab, q: string, page = 0): string {
  const qs = new URLSearchParams();
  if (tab !== "pending") qs.set("tab", tab);
  if (q) qs.set("q", q);
  if (page > 0) qs.set("page", String(page));
  const s = qs.toString();
  return s ? `/app/admin/users?${s}` : "/app/admin/users";
}

/** 회원 관리(관리자만 — 아니면 404): 탭(승인 대기/승인됨/거절·정지), 이메일·이름 검색, 승인·거절·정지·정지 해제. */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireAdmin("/app/admin/users");
  const params = await searchParams;
  const tabParam = first(params.tab);
  const tab: AdminUserTab = (ADMIN_USER_TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as AdminUserTab) : "pending";
  const q = (first(params.q) ?? "").trim().slice(0, 100);
  const page = Math.max(0, Number.parseInt(first(params.page) ?? "0", 10) || 0);

  const [{ users, total }, counts] = await Promise.all([listUsersForAdmin(admin.id, { tab, q, page }), countUsersByTab()]);
  const lastPage = Math.max(0, Math.ceil(total / ADMIN_USER_PAGE_SIZE) - 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">회원 관리</h1>
        <p className="mt-1 text-sm text-slate-500">
          새로 가입한 회원은 승인해야 앱을 쓸 수 있습니다. 거절·정지하면 그 회원의 로그인이 모두 해제됩니다. 관리자 계정과 내 계정은 거절·정지할 수 없습니다.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="회원 상태" className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {ADMIN_USER_TABS.map((t) => (
            <Link
              key={t}
              href={hrefFor(t, q)}
              aria-current={t === tab ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                t === tab ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
              )}
            >
              {ADMIN_USER_TAB_LABELS[t]}
              <span className={cn("ml-1.5 tabular-nums", t === "pending" && counts.pending > 0 ? "font-semibold text-rose-600" : "text-slate-400")}>
                {counts[t]}
              </span>
            </Link>
          ))}
        </nav>
        <form action="/app/admin/users" method="get" role="search" className="flex gap-2">
          {tab !== "pending" && <input type="hidden" name="tab" value={tab} />}
          <label htmlFor="admin-user-q" className="sr-only">
            이메일·이름 검색
          </label>
          <input
            id="admin-user-q"
            name="q"
            defaultValue={q}
            placeholder="이메일·이름 검색"
            maxLength={100}
            className="h-9 w-56 rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
          />
          <button type="submit" className={buttonClass("secondary", "sm", "h-9")}>
            검색
          </button>
        </form>
      </div>

      <Card className="overflow-hidden">
        {users.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            {q ? `'${q}'에 맞는 회원이 없습니다.` : `${ADMIN_USER_TAB_LABELS[tab]} 회원이 없습니다.`}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5">
                    회원
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    상태
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    가입
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    최근 로그인
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    관리
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((u) => (
                  <tr key={u.id} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium break-all text-slate-900">
                        {u.email}
                        {u.id === admin.id && <span className="ml-1.5 text-xs font-normal text-slate-400">(나)</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {u.name ?? "이름 없음"}
                        {u.googleLinked ? " · Google" : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={STATUS_TONE[u.status]}>{USER_STATUS_LABELS[u.status]}</Badge>
                        {u.role === "admin" && <Badge tone="accent">관리자</Badge>}
                      </div>
                      {u.statusChangedAt && u.status !== "pending" && (
                        <p className="mt-1 text-xs text-slate-400">{formatDateTime(u.statusChangedAt)}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-600">{formatDateTime(u.createdAt)}</td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-600">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <AdminUserActions userId={u.id} email={u.email} actions={u.actions} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {lastPage > 0 && (
        <nav aria-label="페이지" className="flex items-center justify-center gap-3 text-sm">
          {page > 0 ? (
            <Link href={hrefFor(tab, q, page - 1)} className={buttonClass("secondary", "sm")}>
              이전
            </Link>
          ) : (
            <span className={buttonClass("secondary", "sm", "pointer-events-none opacity-50")}>이전</span>
          )}
          <span className="text-slate-500 tabular-nums">
            {page + 1} / {lastPage + 1}
          </span>
          {page < lastPage ? (
            <Link href={hrefFor(tab, q, page + 1)} className={buttonClass("secondary", "sm")}>
              다음
            </Link>
          ) : (
            <span className={buttonClass("secondary", "sm", "pointer-events-none opacity-50")}>다음</span>
          )}
        </nav>
      )}
    </div>
  );
}
