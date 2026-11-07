"use client";

/**
 * 회원 탈퇴 버튼 + 확인 대화상자. 확인 문구(ACCOUNT_DELETE_CONFIRM)를 직접 입력해야 탈퇴 버튼이 켜진다.
 * DELETE /api/account → 성공하면 첫 화면으로. 경험 그래프 삭제가 실패하면 아무것도 지우지 않고 오류를 보여 준다.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ACCOUNT_DELETE_CONFIRM } from "@/lib/domain/users";

export function DeleteAccountButton({ variant = "danger" }: { variant?: "danger" | "ghost" }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  function close() {
    if (pending) return;
    setOpen(false);
    setConfirm("");
    setError(null);
  }

  async function withdraw() {
    if (confirm !== ACCOUNT_DELETE_CONFIRM || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      if (res.ok) {
        router.replace("/?withdrawn=1");
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(json?.error ?? "탈퇴를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } catch {
      setError("네트워크 오류가 발생했습니다. 연결을 확인해 주세요.");
    }
    setPending(false);
  }

  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}>
        회원 탈퇴
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
      >
        <div className="space-y-4 p-5 text-sm text-slate-700">
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            회원 탈퇴
          </h2>
          <p>탈퇴하면 아래 정보가 지체 없이 삭제되며 되돌릴 수 없습니다.</p>
          <ul className="list-disc space-y-1 pl-5 text-slate-600">
            <li>계정 정보(이메일·이름·로그인 정보)와 모든 로그인 세션, MCP 연결 토큰</li>
            <li>진단·이력서·채용공고 보관함·지원 기록·대화 내용과 올린 파일(포트폴리오 원본 파일 포함)·프로필 사진</li>
            <li>경험 그래프</li>
            <li>동의 기록</li>
          </ul>
          <p className="text-xs text-slate-500">
            ‘공고 찾기’에 공유된 공고 내용(URL로 가져오거나 직접 입력한 채용공고)은 남지만, 회원님과의 연결은 삭제됩니다. 메모·지원 상태는 삭제됩니다.
          </p>
          <div>
            <label htmlFor={inputId} className="mb-1.5 block font-medium text-slate-800">
              확인을 위해 <strong className="text-red-700">{ACCOUNT_DELETE_CONFIRM}</strong>를 입력해 주세요.
            </label>
            <input
              id={inputId}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void withdraw();
                }
              }}
              autoComplete="off"
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-red-400 focus:ring-2 focus:ring-red-100 focus:outline-none"
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={close} disabled={pending}>
              취소
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={withdraw}
              loading={pending}
              disabled={confirm !== ACCOUNT_DELETE_CONFIRM}
            >
              탈퇴하기
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
