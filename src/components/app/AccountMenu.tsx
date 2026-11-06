"use client";

/**
 * 사이드바 하단 계정 메뉴. 트리거 하나(아바타 + 이름·이메일 + ⌄)를 누르면 짧은 명령 메뉴가 열린다.
 * WAI-ARIA APG 메뉴 버튼 패턴: Enter·Space·↓ → 첫 항목, ↑ → 마지막 항목, ↑↓·Home·End 이동(순환),
 * 첫 글자 이동, Esc → 닫고 트리거로 포커스 복귀, Tab → 닫고 다음 요소로, 바깥 클릭·경로 변경 → 닫기.
 *
 * placement: "top"(펼친 사이드바·모바일 서랍 — 트리거 위로, 같은 폭) / "right"(접힌 사이드바 — 트리거 오른쪽, 아래 정렬).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";

const TINTS = [
  "bg-indigo-100 text-indigo-700",
  "bg-violet-100 text-violet-700",
  "bg-sky-100 text-sky-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
  "bg-fuchsia-100 text-fuchsia-700",
];

/** 이메일로 고른 고정 색(구분용일 뿐 의미는 없다). */
function tintFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

function displayName(name: string | null | undefined, email: string): string {
  const n = name?.trim();
  if (n) return n;
  const local = email.split("@")[0]?.trim();
  return local || email;
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
}

function Avatar({ label, tintKey, size }: { label: string; tintKey: string; size: "sm" | "md" }) {
  const initial = Array.from(label)[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-lg font-semibold select-none",
        size === "md" ? "size-9 text-sm" : "size-8 text-xs",
        tintFor(tintKey),
      )}
    >
      {initial}
    </span>
  );
}

const itemBase =
  "flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-slate-100 focus:bg-slate-100 max-lg:h-11";

export function AccountMenu({
  email,
  name,
  collapsed = false,
  placement = "top",
  showConnections = false,
  onNavigate,
}: {
  email: string;
  name?: string | null;
  collapsed?: boolean;
  placement?: "top" | "right";
  showConnections?: boolean;
  /** 메뉴의 링크를 눌렀을 때(모바일 서랍 닫기용). */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 열릴 때 포커스할 항목: "first" | "last" */
  const focusOnOpen = useRef<"first" | "last">("first");
  const triggerId = useId();
  const menuId = useId();
  const label = displayName(name, email);

  // 경로가 바뀌면 닫는다(렌더 중 상태 조정 — 이전 경로와 비교).
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (open) setOpen(false);
  }


  // 열리면 첫(또는 마지막) 항목으로 포커스, 바깥 클릭이면 닫는다.
  useEffect(() => {
    if (!open) return;
    const list = menuItems(menuRef.current);
    (focusOnOpen.current === "last" ? list[list.length - 1] : list[0])?.focus();
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openMenu(where: "first" | "last") {
    focusOnOpen.current = where;
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu("last");
    } else if (e.key === "Escape" && open) {
      // 서랍 안이면 서랍까지 닫히지 않게 막는다.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const list = menuItems(menuRef.current);
    const i = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(i + 1);
      case "ArrowUp":
        return move(i < 0 ? list.length - 1 : i - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // 서랍의 Esc 처리보다 먼저 — 메뉴만 닫는다.
        return close(true);
      case "Tab":
        // 기본 동작은 그대로 두고, 트리거 기준으로 다음 요소로 넘어가게 한다.
        return close(true);
      default:
        if (e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) {
          const ch = e.key.toLocaleLowerCase();
          const order = [...list.slice(i + 1), ...list.slice(0, i + 1)];
          const hit = order.find((el) => el.textContent?.trim().toLocaleLowerCase().startsWith(ch));
          if (hit) {
            e.preventDefault();
            hit.focus();
          }
        }
    }
  }

  async function logout() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/");
      router.refresh();
    }
  }

  function linkItem(href: string, text: string, icon: ReactNode) {
    const current = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        href={href}
        role="menuitem"
        tabIndex={-1}
        aria-current={current ? "page" : undefined}
        onClick={() => {
          setOpen(false);
          onNavigate?.();
        }}
        className={cn(itemBase, current ? "font-medium text-indigo-700" : "text-slate-700")}
      >
        <span aria-hidden className={cn("shrink-0", current ? "text-indigo-600" : "text-slate-400")}>
          {icon}
        </span>
        <span className="flex-1 truncate">{text}</span>
        {current && <CheckIcon />}
      </Link>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={collapsed ? `계정 메뉴: ${email}` : undefined}
        title={collapsed ? email : undefined}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex w-full items-center rounded-lg text-left transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-600 aria-expanded:bg-slate-100",
          collapsed ? "h-11 justify-center px-0" : "h-12 gap-3 px-2 max-lg:h-14",
        )}
      >
        <Avatar label={label} tintKey={email} size={collapsed ? "md" : "sm"} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-slate-900">{label}</span>
              <span className="mt-0.5 block truncate text-xs text-slate-500" title={email}>
                {email}
              </span>
            </span>
            <ChevronsUpDownIcon />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
          className={cn(
            "absolute z-50 rounded-xl border border-slate-200 bg-white p-1 shadow-lg motion-safe:transition motion-safe:duration-150 motion-safe:ease-out motion-safe:starting:scale-95 motion-safe:starting:opacity-0",
            placement === "right" ? "bottom-0 left-full ml-4 w-60 origin-bottom-left" : "inset-x-0 bottom-full mb-2 origin-bottom",
          )}
        >
          {/* 헤더: 포커스 받지 않음, 이메일 전체를 줄바꿈해 보여 준다. */}
          <div role="none" className="flex items-center gap-2.5 px-2 py-2">
            <Avatar label={label} tintKey={email} size="sm" />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-medium text-slate-900">{label}</p>
              <p className="mt-0.5 text-xs break-all text-slate-500">{email}</p>
            </div>
          </div>
          <div role="separator" className="-mx-1 my-1 h-px bg-slate-100" />
          {linkItem("/app/account", "계정 설정", <UserIcon />)}
          {linkItem("/app/mcp", "MCP 연결", <McpIcon />)}
          {showConnections && linkItem("/app/connections", "AI 연결", <PlugIcon />)}
          <div role="separator" className="-mx-1 my-1 h-px bg-slate-100" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={pending || undefined}
            onClick={logout}
            className={cn(itemBase, "text-slate-700 hover:text-red-600 focus:text-red-600", pending && "cursor-wait opacity-70")}
          >
            <span aria-hidden className="grid size-[18px] shrink-0 place-items-center text-slate-400">
              {pending ? <Spinner size="sm" /> : <LogoutIcon />}
            </span>
            <span className="flex-1">{pending ? "로그아웃 중…" : "로그아웃"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- 아이콘(인라인 SVG, currentColor) ----

function Svg({ children, size = 18, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

function ChevronsUpDownIcon() {
  return (
    <Svg size={16} className="shrink-0 text-slate-400">
      <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
    </Svg>
  );
}

function CheckIcon() {
  return (
    <Svg size={16} className="shrink-0 text-indigo-600">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}

function UserIcon() {
  return (
    <Svg>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Svg>
  );
}

function PlugIcon() {
  return (
    <Svg>
      <path d="M9 3.5v4M15 3.5v4" />
      <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16v4.5" />
    </Svg>
  );
}

function McpIcon() {
  return (
    <Svg>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.3 10.8l7.4-3.6M8.3 13.2l7.4 3.6" />
    </Svg>
  );
}

function LogoutIcon() {
  return (
    <Svg>
      <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
      <path d="M17 8.5l3.5 3.5-3.5 3.5M20.5 12H10" />
    </Svg>
  );
}
