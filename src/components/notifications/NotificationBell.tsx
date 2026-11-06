"use client";
/**
 * 상단 알림 버튼(넓은 화면은 본문 위 얇은 바, 좁은 화면은 상단 바 오른쪽). 읽지 않은 수 배지, 누르면 최근 알림 패널(제목·한 줄·시각·링크).
 * 패널을 열면 최근 목록을 다시 받고 보이는 알림을 읽음으로 바꾼다(이번에 열린 동안은 '새 알림' 표시를 남긴다). '모두 읽음'도 있다.
 * Esc·바깥 클릭·경로 변경으로 닫는다. 새 알림 스트림(SSE)·상태는 ./store.ts(탭에 하나).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { isFailureNotification, timeAgo, type NotificationItem } from "@/lib/domain/notifications";
import { getNotificationState, markAllNotificationsRead, markNotificationsRead, pollNotifications, useNotifications } from "./store";

export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function NotificationBell({ align = "right" }: { align?: "right" | "left" }) {
  const { items, unreadCount, loaded, error } = useNotifications();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** 이번에 패널을 열 때 읽지 않았던 알림(열려 있는 동안 강조 표시). */
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  /** 패널을 열 때마다·닫을 때마다 바뀐다. 목록을 받는 사이 닫혔으면(또는 다시 열렸으면) 읽음 처리하지 않는다. */
  const openToken = useRef(0);
  useEffect(() => {
    if (!open) openToken.current++;
  }, [open]);

  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const token = ++openToken.current;
    setOpen(true);
    setHighlight(new Set());
    setRefreshing(true);
    await pollNotifications({ full: true });
    setRefreshing(false);
    // 받는 사이 패널을 닫았으면 사용자가 보지 못한 것이므로 읽음으로 바꾸지 않는다.
    if (openToken.current !== token) return;
    // 열 때 보인 읽지 않은 알림을 읽음으로 바꾼다(이번에 열려 있는 동안은 강조 표시를 남긴다).
    const ids = getNotificationState().items.filter((n) => n.readAt === null).map((n) => n.id);
    setHighlight(new Set(ids));
    void markNotificationsRead(ids);
  }

  const label = unreadCount > 0 ? `알림 (읽지 않은 알림 ${unreadCount}개)` : "알림";
  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => void toggle()}
        aria-label={label}
        title="알림"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="relative inline-flex size-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600"
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[10px] leading-4 font-semibold text-white tabular-nums ring-2 ring-white"
          >
            {badgeText(unreadCount)}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="알림"
          className={cn(
            "absolute top-full z-50 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
            <p className="text-sm font-semibold text-slate-900">알림</p>
            <div className="flex items-center gap-2">
              {refreshing && <Spinner size="sm" />}
              <button
                type="button"
                onClick={() => void markAllNotificationsRead()}
                disabled={items.every((n) => n.readAt !== null) && unreadCount === 0}
                className="text-xs font-medium text-indigo-700 hover:underline disabled:cursor-default disabled:text-slate-300 disabled:no-underline"
              >
                모두 읽음
              </button>
            </div>
          </div>
          <div className="max-h-[min(28rem,70dvh)] overflow-y-auto">
            {!loaded ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">{error ? "알림을 불러오지 못했습니다." : "불러오는 중…"}</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                아직 알림이 없습니다.
                <span className="mt-1 block text-xs text-slate-400">AI 초안·진단처럼 오래 걸리는 작업이 끝나면 여기에 알려 드립니다.</span>
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((n) => (
                  <li key={n.id}>
                    <NotificationRow item={n} fresh={highlight.has(n.id) || n.readAt === null} onOpen={() => setOpen(false)} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NotificationRow({ item, fresh, onOpen }: { item: NotificationItem; fresh: boolean; onOpen: () => void }) {
  const failed = isFailureNotification(item.kind);
  const body = (
    <>
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", fresh ? (failed ? "bg-rose-500" : "bg-indigo-500") : "bg-transparent")}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", fresh ? "font-semibold text-slate-900" : "font-medium text-slate-700")}>
          {failed && <span className="sr-only">실패: </span>}
          {item.title}
        </span>
        {item.body && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{item.body}</span>}
        <span className="mt-1 block text-[11px] text-slate-400">
          <time dateTime={new Date(item.createdAt).toISOString()}>{timeAgo(item.createdAt)}</time>
        </span>
      </span>
    </>
  );
  const cls = cn("flex gap-2.5 px-4 py-3 text-left", fresh && "bg-indigo-50/40");
  return item.link ? (
    <Link
      href={item.link}
      onClick={() => {
        void markNotificationsRead([item.id]);
        onOpen();
      }}
      className={cn(cls, "hover:bg-slate-50")}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="size-5" aria-hidden>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
