import Link from "next/link";
import type { MouseEvent } from "react";
import { pageItems } from "@/lib/pagination";
import { cn } from "./cn";

const item = "inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2.5 text-sm font-medium transition-colors";

/**
 * 쪽 이동 링크(이전·쪽 번호·다음). 현재 쪽은 aria-current="page", 갈 수 없는 이전·다음은 링크가 아닌 aria-disabled 글자다.
 * hrefFor는 지금 검색·필터를 그대로 싣고 쪽 번호만 바꾼 주소를 돌려준다. 1쪽뿐이면 그리지 않는다.
 * onNavigate를 주면 보통 클릭(수정키 없는 왼쪽 클릭)은 링크 이동 대신 onNavigate(href)를 부른다 — 부르는 쪽이
 * startTransition 안에서 router.push해 서버가 다음 쪽을 읽는 동안 목록을 흐리게(aria-busy) 표시한다. 새 탭 열기 등은 그대로 링크다.
 */
export function Pagination({
  page,
  pageCount,
  hrefFor,
  label = "목록 쪽 이동",
  className,
  onNavigate,
}: {
  page: number;
  pageCount: number;
  hrefFor: (page: number) => string;
  label?: string;
  className?: string;
  /** 보통 클릭으로 쪽을 옮길 때(링크 기본 이동 대신). */
  onNavigate?: (href: string) => void;
}) {
  if (pageCount <= 1) return null;
  const clickFor = (href: string) =>
    onNavigate
      ? (e: MouseEvent<HTMLAnchorElement>) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onNavigate(href);
        }
      : undefined;
  const edge = (to: number, text: string, rel: "prev" | "next") =>
    to < 1 || to > pageCount ? (
      <span aria-disabled="true" className={cn(item, "cursor-default text-slate-300")}>
        {text}
      </span>
    ) : (
      <Link href={hrefFor(to)} rel={rel} onClick={clickFor(hrefFor(to))} className={cn(item, "text-slate-700 hover:bg-slate-100")}>
        {text}
      </Link>
    );
  return (
    <nav aria-label={label} className={cn("flex justify-center", className)}>
      <ul className="flex flex-wrap items-center gap-1">
        <li>{edge(page - 1, "이전", "prev")}</li>
        {pageItems(page, pageCount).map((n, i) =>
          n === "gap" ? (
            <li key={`gap-${i}`} aria-hidden className={cn(item, "min-w-6 px-0 text-slate-400")}>
              …
            </li>
          ) : (
            <li key={n}>
              <Link
                href={hrefFor(n)}
                onClick={clickFor(hrefFor(n))}
                aria-current={n === page ? "page" : undefined}
                aria-label={`${n}쪽`}
                className={cn(item, n === page ? "bg-indigo-600 text-white hover:bg-indigo-700" : "text-slate-700 hover:bg-slate-100")}
              >
                {n}
              </Link>
            </li>
          ),
        )}
        <li>{edge(page + 1, "다음", "next")}</li>
      </ul>
    </nav>
  );
}
