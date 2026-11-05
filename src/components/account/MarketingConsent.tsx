"use client";

/** 광고성 정보 수신 동의·철회(설정 > 계정) → PATCH /api/account/consents. 가입할 때만큼 쉽게 철회할 수 있어야 한다(법 제37조). */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MarketingNotice } from "@/components/legal/PrivacySummary";
import { Button } from "@/components/ui/Button";

export function MarketingConsent({ agreed }: { agreed: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(agreed);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function change(next: boolean) {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/account/consents", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketing: next }),
      });
      if (res.ok) {
        setValue(next);
        setMessage({
          tone: "ok",
          text: next ? "광고성 정보 수신에 동의했습니다." : "광고성 정보 수신 동의를 철회했습니다. 서비스 이용에는 영향이 없습니다.",
        });
        router.refresh();
      } else {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage({ tone: "error", text: json?.error ?? "저장하지 못했습니다." });
      }
    } catch {
      setMessage({ tone: "error", text: "네트워크 오류가 발생했습니다." });
    }
    setPending(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-800">
          광고성 정보(새 기능·이벤트 안내) 이메일 수신:{" "}
          <strong className={value ? "text-emerald-700" : "text-slate-500"}>{value ? "동의함" : "동의하지 않음"}</strong>
        </p>
        <Button size="sm" variant={value ? "secondary" : "primary"} loading={pending} onClick={() => change(!value)}>
          {value ? "수신 동의 철회" : "수신 동의하기(선택)"}
        </Button>
      </div>
      {!value && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-800">동의 내용 보기</summary>
          <div className="mt-2">
            <MarketingNotice />
          </div>
        </details>
      )}
      {message && (
        <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-red-600" : "text-sm text-emerald-700"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
