"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConsentChecklist } from "@/components/legal/ConsentChecklist";
import { DeleteAccountButton } from "@/components/account/DeleteAccount";
import { LogoutButton } from "@/components/account/LogoutButton";
import { Button } from "@/components/ui/Button";
import { CONSENT_TYPES, EMPTY_CONSENT_CHECKS, REQUIRED_CONSENT_TYPES, requiredConsentsChecked, type ConsentChecks } from "@/lib/legal/consents";

/** 동의 화면 폼 → POST /api/consents. 성공하면 승인 상태에 따라 원래 화면 또는 승인 대기 화면으로. */
export function ConsentGateForm({ next, showMarketing }: { next: string; showMarketing: boolean }) {
  const router = useRouter();
  const [checks, setChecks] = useState<ConsentChecks>(EMPTY_CONSENT_CHECKS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = requiredConsentsChecked(checks);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/consents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checks),
      });
      const json = (await res.json().catch(() => null)) as { decision?: string; error?: string } | null;
      if (res.ok) {
        router.replace(json?.decision === "ok" ? next : "/pending");
        router.refresh();
        return;
      }
      setError(json?.error ?? "저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } catch {
      setError("네트워크 오류가 발생했습니다. 연결을 확인해 주세요.");
    }
    setPending(false);
  }

  return (
    <div className="space-y-4">
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
      <ConsentChecklist
        checks={checks}
        onChange={setChecks}
        types={showMarketing ? CONSENT_TYPES : REQUIRED_CONSENT_TYPES}
      />
      <Button type="submit" className="w-full" disabled={!ready} loading={pending}>
        확인하고 계속하기
      </Button>
    </form>
      <p className="text-center text-xs text-slate-500">동의하지 않으려면 로그아웃하거나 회원 탈퇴할 수 있습니다.</p>
      <div className="flex justify-center gap-2">
        <LogoutButton />
        <DeleteAccountButton variant="ghost" />
      </div>
    </div>
  );
}
