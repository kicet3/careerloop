"use client";
/**
 * 설정 > 계정 > 로그인 정보 카드. 오른쪽 위 [수정]을 누르면 이름만 바꿀 수 있다(이메일·Google 연결은 Google 계정이 정하므로 읽기 전용).
 * 저장하면 서버 화면을 다시 그려 사이드바·계정 메뉴 이름도 바뀐다.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui";

const MAX = 40;

export function LoginInfoCard({ email, name: initialName, googleLinked }: { email: string; name: string | null; googleLinked: boolean }) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function startEdit() {
    setDraft(name);
    setError(null);
    setSaved(false);
    setEditing(true);
  }

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

  return (
    <Card>
      <CardHeader
        title="로그인 정보"
        action={
          editing ? null : (
            <Button size="sm" variant="secondary" onClick={startEdit}>
              수정
            </Button>
          )
        }
      />
      <CardBody>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <dl className="grid max-w-lg grid-cols-[7rem_1fr] items-center gap-y-2 text-sm">
            <dt className="text-slate-500">이메일</dt>
            <dd className="break-all text-slate-900">{email}</dd>
            <dt className="text-slate-500">
              {editing ? (
                <label htmlFor="account-name">이름</label>
              ) : (
                "이름"
              )}
            </dt>
            <dd>
              {editing ? (
                <input
                  id="account-name"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={MAX}
                  autoFocus
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "account-name-error" : undefined}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:ring-indigo-500"
                />
              ) : (
                <span className="text-slate-900">{name || <span className="text-slate-400">이름 없음</span>}</span>
              )}
            </dd>
            <dt className="text-slate-500">Google</dt>
            <dd className="text-slate-900">{googleLinked ? "연결됨" : "연결 안 됨"}</dd>
          </dl>
          {error && (
            <p id="account-name-error" className="mt-2 text-xs text-red-700">
              {error}
            </p>
          )}
          {editing ? (
            <div className="mt-4 flex gap-2">
              <Button size="sm" type="submit" loading={busy} disabled={busy}>
                저장
              </Button>
              <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>
                취소
              </Button>
              <span className="self-center text-xs text-slate-500">이메일과 Google 연결은 Google 계정에서 정해져 바꿀 수 없습니다.</span>
            </div>
          ) : (
            saved && (
              <p className="mt-2 text-xs text-emerald-700" role="status">
                이름을 바꿨습니다.
              </p>
            )
          )}
        </form>
      </CardBody>
    </Card>
  );
}
