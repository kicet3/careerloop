"use client";
/** 설정 > 계정 > 로그인 정보의 이름 줄: 보기 ↔ 바꾸기. 저장하면 서버 화면을 다시 그려 사이드바·계정 메뉴 이름도 바뀐다. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

const MAX = 40;

export function NameForm({ initialName }: { initialName: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const value = draft.replace(/\s+/g, " ").trim();
    if (!value) {
      setError("이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "이름을 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setName(data.name ?? value);
      setEditing(false);
      setSaved(true);
      router.refresh();
    } catch {
      setError("이름을 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-900">{name || <span className="text-slate-400">이름 없음</span>}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(name);
            setError(null);
            setSaved(false);
            setEditing(true);
          }}
        >
          바꾸기
        </Button>
        {saved && (
          <span className="text-xs text-emerald-700" role="status">
            저장했습니다.
          </span>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="account-name" className="sr-only">
          이름
        </label>
        <input
          id="account-name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX}
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "account-name-error" : undefined}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:ring-indigo-500"
        />
        <Button size="sm" type="submit" loading={busy} disabled={busy}>
          저장
        </Button>
        <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>
          취소
        </Button>
      </div>
      {error && (
        <p id="account-name-error" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
