"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { Logo } from "./Logo";
import { LogoutButton } from "./LogoutButton";

const LINKS = [
  { href: "/app/new", label: "새 진단", match: (p: string) => p === "/app/new" },
  { href: "/app", label: "내 진단", match: (p: string) => p === "/app" || p.startsWith("/app/d/") },
];

export function AppNav({ email }: { email: string }) {
  const pathname = usePathname() ?? "";
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <Logo href="/app" />
        <nav aria-label="주 메뉴" className="ml-1 flex items-center gap-1 sm:ml-4">
          {LINKS.map((l) => {
            const active = l.match(pathname);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-sm font-medium whitespace-nowrap",
                  active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span className="hidden truncate text-sm text-slate-500 md:inline" title={email}>
            {email}
          </span>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
