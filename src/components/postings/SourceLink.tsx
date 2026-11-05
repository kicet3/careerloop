"use client";

import type { MouseEvent } from "react";
import { cn } from "@/components/ui/cn";
import { safeSourceUrl, sourceHostLabel } from "@/lib/postings/source-link";

/**
 * "원문 공고 열기 ↗" 링크. http/https 주소가 아니면 아무것도 그리지 않는다. 새 탭(noopener noreferrer)으로 연다.
 * variant 'icon'은 카드 안에 두는 작은 아이콘 버튼 — 클릭이 카드 이동(부모 링크·onClick)으로 번지지 않게 막는다.
 * 카드 전체가 <Link>라면 이 컴포넌트를 그 링크 밖(형제)에 두어야 한다(<a> 안에 <a>는 HTML에서 허용되지 않는다).
 */
export function SourceLink({
  url,
  variant = "text",
  label = "원문 공고 열기",
  className,
}: {
  url: string | null | undefined;
  variant?: "text" | "button" | "icon";
  label?: string;
  className?: string;
}) {
  const href = safeSourceUrl(url);
  if (!href) return null;
  const host = sourceHostLabel(href);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const common = {
    href,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: stop,
    title: `${label} (${host}, 새 탭)`,
  } as const;
  if (variant === "icon") {
    return (
      <a
        {...common}
        aria-label={`${label} (새 탭)`}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none",
          className,
        )}
      >
        <span aria-hidden>↗</span>
      </a>
    );
  }
  return (
    <a
      {...common}
      className={cn(
        variant === "button"
          ? "inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          : "inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:underline",
        className,
      )}
    >
      {label} <span aria-hidden>↗</span>
      <span className="sr-only"> (새 탭)</span>
    </a>
  );
}
