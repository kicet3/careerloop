"use client";
/**
 * 새 알림이 오면(SSE) 화면 오른쪽 아래에 잠깐 띄운다(앱 틀에 하나). '열어 보기'를 누르면 읽음으로 바꾸고, 닫기·시간 경과는
 * 토스트만 닫는다(배지에는 남는다). 지금 보고 있는 화면의 알림(링크가 현재 경로)은 띄우지 않는다 — 이미 결과가 보인다.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/components/ui/cn";
import { isFailureNotification, type NotificationItem } from "@/lib/domain/notifications";
import { dismissToast, markNotificationsRead, useNotifications } from "./store";

const TOAST_MS = 8000;

export function NotificationToasts() {
  const { toasts } = useNotifications();
  const pathname = usePathname() ?? "";
  const here = (t: NotificationItem) => t.link?.split("?")[0] === pathname;
  const shown = toasts.filter((t) => !here(t));
  const hereKey = toasts.filter(here).map((t) => t.id).join(",");
  useEffect(() => {
    if (hereKey) for (const id of hereKey.split(",")) dismissToast(id);
  }, [hereKey]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 print:hidden">
      {shown.map((t) => (
        <Toast key={t.id} item={t} />
      ))}
    </div>
  );
}

function Toast({ item }: { item: NotificationItem }) {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(item.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [item.id]);
  const failed = isFailureNotification(item.kind);
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-xl border bg-white px-4 py-3 shadow-lg",
        failed ? "border-rose-200" : "border-indigo-200",
      )}
    >
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", failed ? "bg-rose-500" : "bg-indigo-500")} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{item.title}</p>
        {item.body && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{item.body}</p>}
        {item.link && (
          <Link
            href={item.link}
            onClick={() => void markNotificationsRead([item.id])}
            className="mt-1.5 inline-block text-xs font-medium text-indigo-700 hover:underline"
          >
            열어 보기
          </Link>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismissToast(item.id)}
        aria-label="알림 닫기"
        className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="size-4" aria-hidden>
          <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
        </svg>
      </button>
    </div>
  );
}
