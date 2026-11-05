"use client";

/**
 * 앱 주 메뉴(진단·경력·서류·지원·설정 그룹). 넓은 화면(lg 이상, 1024px~)은 왼쪽 고정 사이드바(아이콘만 보이는 접힌 모드 지원),
 * 좁은 화면은 상단 얇은 바 + 햄버거 → 왼쪽 서랍(오버레이). 인쇄할 때는 둘 다 숨긴다.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { BusinessInfo } from "./BusinessInfo";
import { EnvBadge } from "./EnvBadge";
import { Logo } from "./Logo";

type AppEnv = "DEV" | "PRODUCTION";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  match: (p: string) => boolean;
}

const under = (base: string) => (p: string) => p === base || p.startsWith(`${base}/`);

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: "진단",
    items: [
      { href: "/app/new", label: "새 진단", icon: <PlusIcon />, match: (p) => p === "/app/new" },
      { href: "/app", label: "내 진단", icon: <ListIcon />, match: (p) => p === "/app" || p.startsWith("/app/d/") },
    ],
  },
  { label: "경력", items: [{ href: "/app/graph", label: "경력 그래프", icon: <GraphIcon />, match: under("/app/graph") }] },
  { label: "서류", items: [{ href: "/app/resumes", label: "이력서", icon: <DocIcon />, match: under("/app/resumes") }] },
  {
    label: "지원",
    items: [
      { href: "/app/postings", label: "공고 보관함", icon: <BookmarkIcon />, match: under("/app/postings") },
      { href: "/app/applications", label: "지원 현황", icon: <BoardIcon />, match: under("/app/applications") },
    ],
  },
];
const SETTINGS_GROUP: NavGroup = {
  label: "설정",
  items: [{ href: "/app/connections", label: "AI 연결", icon: <PlugIcon />, match: under("/app/connections") }],
};

// ---- 접힘 상태: localStorage에 기억. 막혀 있으면(사파리 개인 모드 등) 이 탭 안에서만 기억한다. ----

const COLLAPSE_KEY = "app.sidebar.collapsed";
const collapseListeners = new Set<() => void>();
let collapsedInMemory: boolean | null = null;

function readCollapsed(): boolean {
  if (collapsedInMemory !== null) return collapsedInMemory;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean) {
  collapsedInMemory = value;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0");
  } catch {
    // 저장 못 해도 이 탭에서는 collapsedInMemory로 유지된다.
  }
  collapseListeners.forEach((l) => l());
}

function subscribeCollapsed(listener: () => void) {
  collapseListeners.add(listener);
  // 다른 탭에서 바꾼 값을 따라간다.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== COLLAPSE_KEY) return;
    collapsedInMemory = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    collapseListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 서버 렌더와 첫 하이드레이션은 펼친 상태로 그리고, 직후 저장된 값으로 맞춘다(하이드레이션 불일치 없음). */
function useCollapsed(): [boolean, (v: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  return [collapsed, writeCollapsed];
}

// ---- 컴포넌트 ----

/** showConnections: CLI 엔진(CLI_PROVIDERS=1)이 켜져 있을 때만 'AI 연결' 메뉴를 보인다. */
export function AppSidebar({
  email,
  showConnections = false,
  env,
}: {
  email: string;
  showConnections?: boolean;
  env: AppEnv;
}) {
  const pathname = usePathname() ?? "";
  const groups = showConnections ? [...GROUPS, SETTINGS_GROUP] : GROUPS;
  const [collapsed, setCollapsed] = useCollapsed();

  // 서랍은 연 시점의 경로를 기억한다 — 경로가 바뀌면(메뉴로 이동·뒤로가기) 닫고 기록도 지운다.
  // 기록을 남겨 두면 뒤로가기로 그 경로에 돌아왔을 때 서랍이 저절로 다시 열린다.
  const [drawerOpenAt, setDrawerOpenAt] = useState<string | null>(null);
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    // 렌더 중 상태 조정(이전 경로와 비교) — effect로 하면 한 번 열린 채 그려진다.
    setSeenPath(pathname);
    if (drawerOpenAt !== null) setDrawerOpenAt(null);
  }
  const drawerOpen = drawerOpenAt !== null && drawerOpenAt === pathname;
  const closeDrawer = () => setDrawerOpenAt(null);

  return (
    <>
      {/*
        넓은 화면: 고정 사이드바. 바깥 칸은 flex 행 높이만큼 늘어나 배경·경계선이 긴 페이지 끝까지 이어지고,
        안쪽 메뉴는 sticky + 화면 높이(h-dvh)로 붙어 있으면서 메뉴가 길면 자체 스크롤한다.
      */}
      <div
        className={cn(
          "hidden shrink-0 border-r border-slate-200 bg-white lg:block print:hidden",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <aside aria-label="사이드 메뉴" className="sticky top-0 flex h-dvh flex-col">
          <div
            className={cn(
              "flex min-h-14 border-b border-slate-100 py-3",
              collapsed ? "flex-col items-center justify-center gap-1.5 px-2" : "items-center gap-2 px-4",
            )}
          >
            <Logo href="/app" iconOnly={collapsed} />
            <EnvBadge env={env} />
          </div>
          <NavList groups={groups} pathname={pathname} collapsed={collapsed} className="flex-1 overflow-y-auto" />
          <div className={cn("border-t border-slate-100 py-3", collapsed ? "px-2" : "px-3")}>
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? "메뉴 펼치기" : "메뉴 접기"}
              title={collapsed ? "메뉴 펼치기" : undefined}
              className={cn(itemClass(false), collapsed && "justify-center px-0")}
            >
              <CollapseIcon flipped={collapsed} />
              {!collapsed && <span>메뉴 접기</span>}
            </button>
            <Account email={email} collapsed={collapsed} />
            {/* 접힌 모드(w-16)는 폭이 좁아 사업자 정보를 숨긴다. */}
            {!collapsed && <BusinessInfo compact className="mt-3 px-1" />}
          </div>
        </aside>
      </div>

      {/* 좁은 화면: 상단 얇은 바 + 서랍 */}
      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur lg:hidden print:hidden">
        <MenuButton open={drawerOpen} onOpen={() => setDrawerOpenAt(pathname)} />
        <Logo href="/app" />
        <EnvBadge env={env} />
      </header>
      {drawerOpen && (
        <Drawer onClose={closeDrawer} badge={<EnvBadge env={env} />}>
          {/* 지금 보고 있는 메뉴를 눌러 경로가 그대로여도 서랍은 닫는다. */}
          <NavList groups={groups} pathname={pathname} collapsed={false} className="flex-1 overflow-y-auto" onNavigate={closeDrawer} />
          <div className="border-t border-slate-100 px-3 py-3">
            <Account email={email} collapsed={false} />
            <BusinessInfo compact className="mt-3 px-1" />
          </div>
        </Drawer>
      )}
    </>
  );
}

function itemClass(active: boolean) {
  return cn(
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
    active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  );
}

function NavList({
  groups,
  pathname,
  collapsed,
  className,
  onNavigate,
}: {
  groups: NavGroup[];
  pathname: string;
  collapsed: boolean;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="주 메뉴" className={cn("py-3", collapsed ? "px-2" : "px-3", className)}>
      {groups.map((group, gi) => (
        <section key={group.label} aria-label={group.label} className={cn(gi > 0 && (collapsed ? "mt-2 border-t border-slate-100 pt-2" : "mt-4"))}>
          {/* 접힌 모드는 그룹 제목 대신 구분선만 보인다. */}
          {!collapsed && <h3 className="mb-1 px-3 text-xs font-semibold tracking-wide text-slate-400">{group.label}</h3>}
          <ul className="space-y-1">
            {group.items.map((item) => {
              const active = item.match(pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    title={collapsed ? item.label : undefined}
                    className={cn(itemClass(active), collapsed && "justify-center px-0")}
                  >
                    <span aria-hidden className={cn("shrink-0", active ? "text-indigo-600" : "text-slate-400")}>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/** 계정 이메일 + 로그아웃. 접힌 모드는 머리글자와 아이콘만 보인다. */
function Account({ email, collapsed }: { email: string; collapsed: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className={cn("mt-2 flex gap-2", collapsed ? "flex-col items-center" : "items-center px-1")}>
      {collapsed ? (
        <span
          title={email}
          className="grid size-8 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 uppercase"
        >
          <span aria-hidden>{email.slice(0, 1)}</span>
          <span className="sr-only">{email}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-slate-500" title={email}>
          {email}
        </span>
      )}
      <button
        type="button"
        onClick={logout}
        disabled={pending}
        aria-label={collapsed ? "로그아웃" : undefined}
        title={collapsed ? "로그아웃" : undefined}
        className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60"
      >
        {pending ? <Spinner size="sm" /> : <LogoutIcon />}
        {!collapsed && <span>로그아웃</span>}
      </button>
    </div>
  );
}

const menuButtonId = "app-drawer-toggle";

function MenuButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <button
      id={menuButtonId}
      type="button"
      onClick={onOpen}
      aria-label="메뉴 열기"
      aria-expanded={open}
      aria-controls="app-drawer"
      className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    >
      <MenuIcon />
    </button>
  );
}

/** 왼쪽 서랍. ESC·바깥 클릭으로 닫고, 열려 있는 동안 Tab 포커스를 안에 가두며, 닫히면 햄버거 버튼으로 포커스를 돌려준다. */
function Drawer({ onClose, badge, children }: { onClose: () => void; badge: ReactNode; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panelRef.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
    // 서랍이 열린 채 넓은 화면으로 바뀌면 사이드바가 대신하므로 닫는다.
    const wide = window.matchMedia("(min-width: 1024px)");
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) onCloseRef.current();
    };

    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
      document.body.style.overflow = prevOverflow;
      document.getElementById(menuButtonId)?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 lg:hidden print:hidden">
      <div className="absolute inset-0 bg-slate-900/40" aria-hidden onClick={onClose} />
      <div
        id="app-drawer"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-dvh w-72 max-w-[85vw] flex-col bg-white shadow-xl"
      >
        <div className="flex h-12 items-center justify-between gap-2 border-b border-slate-100 px-3">
          <h2 id={titleId} className="sr-only">
            주 메뉴
          </h2>
          <div className="flex min-w-0 items-center gap-2">
            <Logo href="/app" />
            {badge}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="메뉴 닫기"
            className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- 아이콘(인라인 SVG, 20px, currentColor) ----

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
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

function ListIcon() {
  return (
    <Svg>
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </Svg>
  );
}

function PlusIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v8M8 12h8" />
    </Svg>
  );
}

function GraphIcon() {
  return (
    <Svg>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="9" cy="18" r="2.5" />
      <path d="M8.3 7l7.3 0.8M7 8.3l1.4 7.3M16.4 10l-5.6 6.2" />
    </Svg>
  );
}

function DocIcon() {
  return (
    <Svg>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" />
      <path d="M14 3.5v5h5M9 13h6M9 16.5h4" />
    </Svg>
  );
}

function BookmarkIcon() {
  return (
    <Svg>
      <path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5z" />
    </Svg>
  );
}

function BoardIcon() {
  return (
    <Svg>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9.2 4v16M14.8 4v16M5.8 8h1.4M11.3 8h1.4M11.3 11.5h1.4M16.8 8h1.4" />
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

function LogoutIcon() {
  return (
    <Svg className="size-[18px]">
      <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
      <path d="M17 8.5l3.5 3.5-3.5 3.5M20.5 12H10" />
    </Svg>
  );
}

function MenuIcon() {
  return (
    <Svg>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

function CloseIcon() {
  return (
    <Svg>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

function CollapseIcon({ flipped }: { flipped: boolean }) {
  return (
    <Svg className={cn("shrink-0 text-slate-400", flipped && "rotate-180")}>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9 4v16M15.5 9.5L13 12l2.5 2.5" />
    </Svg>
  );
}
