/**
 * 공고 화면 위쪽 탭: 내 보관함(개인 공고) / 공고 찾기(링크로 가져온 공용 공고).
 */
import Link from "next/link";
import { cn } from "@/components/ui/cn";

const TABS = [
  { key: "library", href: "/app/postings", label: "내 보관함" },
  { key: "explore", href: "/app/postings/explore", label: "공고 찾기" },
] as const;

export function PostingsTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav aria-label="공고 화면" className="inline-flex rounded-lg border border-slate-200 bg-slate-100/70 p-0.5 text-sm">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-1.5 font-medium transition-colors",
            t.key === active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
