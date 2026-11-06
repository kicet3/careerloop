"use client";

/**
 * 앱 주 메뉴(진단·경력·서류[이력서·포트폴리오]·지원[공고 찾기·공고 보관함·지원 현황]·면접 그룹) + 하단 계정 메뉴(계정 설정·AI 연결·로그아웃). 넓은 화면(lg 이상, 1024px~)은 왼쪽 고정 사이드바(아이콘만 보이는 접힌 모드 지원),
 * 좁은 화면은 상단 얇은 바 + 햄버거 → 왼쪽 서랍(오버레이). 인쇄할 때는 둘 다 숨긴다.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { AccountMenu } from "./AccountMenu";
import { EnvBadge } from "./EnvBadge";
import { Logo } from "./Logo";

type AppEnv = "DEV" | "PRODUCTION";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  match: (p: string) => boolean;
  /** 숫자 배지(0이면 숨김). 회원 관리의 승인 대기 수. */
  badge?: number;
  badgeLabel?: string;
}

const under = (base: string) => (p: string) => p === base || p.startsWith(`${base}/`);

interface NavGroup {
  label: string;
  items: NavItem[];
}

export const GROUPS: NavGroup[] = [
  {
    label: "진단",
    items: [
      { href: "/app/new", label: "새 진단", icon: <PlusIcon />, match: (p) => p === "/app/new" },
      { href: "/app", label: "내 진단", icon: <ListIcon />, match: (p) => p === "/app" || p.startsWith("/app/d/") },
    ],
  },
  { label: "경력", items: [{ href: "/app/graph", label: "경력 그래프", icon: <GraphIcon />, match: under("/app/graph") }] },
  {
    label: "서류",
    items: [
      { href: "/app/resumes", label: "이력서", icon: <DocIcon />, match: under("/app/resumes") },
      { href: "/app/portfolios", label: "포트폴리오", icon: <FolderIcon />, match: under("/app/portfolios") },
    ],
  },
  {
    label: "지원",
    items: [
      // 공고 찾기(공용 공고)는 보관함과 별도 메뉴 — /app/postings/explore 아래는 보관함을 활성으로 표시하지 않는다.
      { href: "/app/postings/explore", label: "공고 찾기", icon: <SearchIcon />, match: under("/app/postings/explore") },
      {
        href: "/app/postings",
        label: "공고 보관함",
        icon: <BookmarkIcon />,
        match: (p) => under("/app/postings")(p) && !under("/app/postings/explore")(p),
      },
      { href: "/app/applications", label: "지원 현황", icon: <BoardIcon />, match: under("/app/applications") },
    ],
  },
  { label: "면접", items: [{ href: "/app/interview", label: "면접 연습", icon: <MicIcon />, match: under("/app/interview") }] },
];

/** 관리자 메뉴(role=admin만). pendingCount는 승인 대기 회원 수. */
function adminGroup(pendingCount: number): NavGroup {
  return {
    label: "관리",
    items: [
      {
        href: "/app/admin/users",
        label: "회원 관리",
        icon: <UsersIcon />,
        match: under("/app/admin/users"),
        badge: pendingCount,
        badgeLabel: `승인 대기 ${pendingCount}명`,
      },
    ],
  };
}

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

/**
 * showConnections: CLI 엔진(CLI_PROVIDERS=1)이 켜져 있을 때만 'AI 연결' 메뉴를 보인다.
 * isAdmin: 관리자면 '관리 > 회원 관리' 메뉴와 승인 대기 배지(pendingCount)를 보인다.
 */
export function AppSidebar({
  email,
  name = null,
  showConnections = false,
  isAdmin = false,
  pendingCount = 0,
  env,
}: {
  email: string;
  name?: string | null;
  showConnections?: boolean;
  isAdmin?: boolean;
  pendingCount?: number;
  env: AppEnv;
}) {
  const pathname = usePathname() ?? "";
  // 계정 설정·AI 연결은 하단 계정 메뉴에 모았다(주 메뉴에 같은 링크를 두지 않는다).
  const groups = isAdmin ? [...GROUPS, adminGroup(pendingCount)] : GROUPS;
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
        {/* z-40: 접힌 모드의 계정 메뉴가 본문 위로 펼쳐진다. */}
        <aside aria-label="사이드 메뉴" className="sticky top-0 z-40 flex h-dvh flex-col">
          <div
            className={cn(
              "flex min-h-14 border-b border-slate-100 py-3",
              collapsed ? "flex-col items-center justify-center gap-1.5 px-2" : "items-center gap-2 px-4",
            )}
          >
            <Logo href="/app" iconOnly={collapsed} />
            <EnvBadge env={env} />
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? "메뉴 펼치기" : "메뉴 접기"}
              title={collapsed ? "메뉴 펼치기" : "메뉴 접기"}
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-indigo-600",
                !collapsed && "ml-auto",
              )}
            >
              <CollapseIcon flipped={collapsed} />
            </button>
          </div>
          <NavList groups={groups} pathname={pathname} collapsed={collapsed} className="flex-1 overflow-y-auto" />
          <div className={cn("border-t border-slate-100 py-2", collapsed ? "px-2" : "px-3")}>
            <AccountMenu
              email={email}
              name={name}
              collapsed={collapsed}
              placement={collapsed ? "right" : "top"}
              showConnections={showConnections}
            />
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
          <div className="border-t border-slate-100 px-3 py-2">
            <AccountMenu email={email} name={name} showConnections={showConnections} onNavigate={closeDrawer} />
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
              const badge = item.badge && item.badge > 0 ? item.badge : 0;
              const fullLabel = badge && item.badgeLabel ? `${item.label} (${item.badgeLabel})` : item.label;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed || badge ? fullLabel : undefined}
                    title={collapsed ? fullLabel : undefined}
                    className={cn(itemClass(active), collapsed && "justify-center px-0")}
                  >
                    <span aria-hidden className={cn("relative shrink-0", active ? "text-indigo-600" : "text-slate-400")}>
                      {item.icon}
                      {collapsed && badge > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-rose-500 ring-2 ring-white" />
                      )}
                    </span>
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && badge > 0 && (
                      <span
                        aria-hidden
                        className="ml-auto rounded-full bg-rose-500 px-1.5 py-px text-[11px] leading-4 font-semibold text-white tabular-nums"
                      >
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
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
        // tabindex=-1(계정 메뉴 항목 등 Tab 순서 밖)은 빼야 처음·끝 판정이 맞다.
        'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
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

function FolderIcon() {
  return (
    <Svg>
      <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M8 13.5h8" />
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

function SearchIcon() {
  return (
    <Svg>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
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

function MicIcon() {
  return (
    <Svg>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5M9 20.5h6" />
    </Svg>
  );
}

function UsersIcon() {
  return (
    <Svg>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <circle cx="16.5" cy="9.5" r="2.5" />
      <path d="M15.5 14.2a4.6 4.6 0 0 1 5 4.8" />
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
