"use client";

/**
 * 회원 한 명의 관리 버튼(승인·거절·정지·정지 해제) → PATCH /api/admin/users/[id]. 성공하면 화면을 새로 읽는다(사이드바 배지 포함).
 * 거절·정지는 확인을 한 번 더 받는다(그 회원의 로그인이 모두 끊긴다).
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { ADMIN_USER_ACTION_LABELS, type AdminUserAction } from "@/lib/domain/users";

const VARIANT: Record<AdminUserAction, ButtonVariant> = {
  approve: "primary",
  unsuspend: "secondary",
  reject: "secondary",
  suspend: "danger",
};

const CONFIRM: Partial<Record<AdminUserAction, (email: string) => string>> = {
  reject: (e) => `${e} 회원의 가입을 거절할까요? 로그인이 모두 해제됩니다.`,
  suspend: (e) => `${e} 회원의 이용을 정지할까요? 로그인이 모두 해제되고 앱을 쓸 수 없게 됩니다.`,
};

export function AdminUserActions({ userId, email, actions }: { userId: string; email: string; actions: AdminUserAction[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<AdminUserAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (actions.length === 0) return <p className="text-right text-xs text-slate-400">변경 불가</p>;

  async function run(action: AdminUserAction) {
    if (busy) return;
    const ask = CONFIRM[action];
    if (ask && !window.confirm(ask(email))) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? "처리하지 못했습니다.");
      }
      router.refresh();
    } catch {
      setError("네트워크 오류가 발생했습니다.");
    }
    setBusy(null);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1.5">
        {actions.map((a) => (
          <Button key={a} size="sm" variant={VARIANT[a]} loading={busy === a} disabled={busy !== null && busy !== a} onClick={() => run(a)}>
            {ADMIN_USER_ACTION_LABELS[a]}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
