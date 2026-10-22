"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Button, buttonClass } from "@/components/ui/Button";

const noopSubscribe = () => () => {};

/** 보고서 상단 액션: PDF·Markdown 내려받기, 공유 링크, 삭제. partial(부분 보고서)이면 공유 링크는 만들 수 없다. */
export function ReportActions({
  id,
  shareToken: initialToken,
  partial = false,
  hasRewrite = true,
}: {
  id: string;
  shareToken: string | null;
  partial?: boolean;
  hasRewrite?: boolean;
}) {
  const router = useRouter();
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState<"share" | "delete" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 서버 렌더에서는 빈 문자열, 하이드레이션 후 실제 origin
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );

  const shareUrl = token ? `${origin}/share/${token}` : null;

  async function toggleShare() {
    setBusy("share");
    setMessage(null);
    try {
      const res = await fetch(`/api/diagnoses/${id}/share`, { method: token ? "DELETE" : "POST" });
      const data = (await res.json().catch(() => null)) as
        | { shareToken?: string | null; token?: string | null; error?: string }
        | null;
      if (!res.ok) {
        setMessage(data?.error ?? "공유 설정을 바꾸지 못했습니다.");
        return;
      }
      if (token) setToken(null);
      else {
        const next = data?.shareToken ?? data?.token ?? null;
        if (!next) setMessage("공유 링크를 받지 못했습니다. 새로고침해 주세요.");
        setToken(next);
      }
      setCopied(false);
      router.refresh();
    } catch {
      setMessage("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("복사하지 못했습니다. 링크를 직접 선택해 복사해 주세요.");
    }
  }

  async function remove() {
    if (!window.confirm("이 진단을 삭제할까요? 보고서와 공유 링크가 모두 사라지며 되돌릴 수 없습니다.")) return;
    setBusy("delete");
    setMessage(null);
    try {
      const res = await fetch(`/api/diagnoses/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage(data?.error ?? "삭제하지 못했습니다.");
        setBusy(null);
        return;
      }
      router.push("/app");
      router.refresh();
    } catch {
      setMessage("서버에 연결하지 못했습니다.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <a href={`/api/diagnoses/${id}/pdf`} className={buttonClass("primary", "md")} download>
          PDF 다운로드
        </a>
        <a href={`/api/diagnoses/${id}/markdown?file=panel`} className={buttonClass("secondary", "md")} download>
          PANEL.md
        </a>
        {hasRewrite && (
          <a href={`/api/diagnoses/${id}/markdown?file=resume`} className={buttonClass("secondary", "md")} download>
            RESUME-IMPROVED.md
          </a>
        )}
        {!partial && (
          <Button variant="secondary" onClick={toggleShare} loading={busy === "share"} aria-pressed={!!token}>
            {token ? "공유 해제" : "공유 링크 만들기"}
          </Button>
        )}
        <Button variant="danger" onClick={remove} loading={busy === "delete"} className="sm:ml-auto">
          삭제
        </Button>
      </div>

      {shareUrl && (
        <div className="flex flex-col gap-2 rounded-lg border border-indigo-100 bg-indigo-50 p-3 sm:flex-row sm:items-center">
          <label htmlFor={`share-${id}`} className="shrink-0 text-sm font-medium text-indigo-900">
            공유 링크
          </label>
          <input
            id={`share-${id}`}
            readOnly
            value={shareUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-md border border-indigo-200 bg-white px-2.5 py-1.5 text-sm text-slate-800"
          />
          <Button size="sm" onClick={copy}>
            {copied ? "복사됨" : "복사"}
          </Button>
          <p className="text-xs text-indigo-900/70 sm:hidden">
            링크가 있는 누구나 로그인 없이 이 보고서(원본 이력서 포함)를 볼 수 있습니다.
          </p>
        </div>
      )}
      {shareUrl && (
        <p className="hidden text-xs text-slate-500 sm:block">
          링크가 있는 누구나 로그인 없이 이 보고서(원본 이력서 포함)를 볼 수 있습니다. 필요 없어지면 공유를 해제하세요.
        </p>
      )}
      {message && (
        <p className="text-sm text-red-700" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
