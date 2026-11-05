import Link from "next/link";
import { cn } from "@/components/ui/cn";

/**
 * compact: 좁은 화면(sm 미만)에서는 글자를 숨기고 "7" 표시만 보인다.
 * iconOnly: 화면 폭과 상관없이 "7" 표시만 보인다(접힌 사이드바).
 */
export function Logo({
  href = "/",
  compact = false,
  iconOnly = false,
}: {
  href?: string;
  compact?: boolean;
  iconOnly?: boolean;
}) {
  const hideText = compact || iconOnly;
  return (
    <Link
      href={href}
      aria-label={hideText ? "커리어루프" : undefined}
      className={cn("flex items-center gap-2 font-bold text-slate-900", hideText && "shrink-0")}
    >
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white"
      >
        7
      </span>
      {!iconOnly && (
        <span className={cn("text-[15px] tracking-tight whitespace-nowrap", compact && "hidden sm:inline")}>
          커리어루프
        </span>
      )}
    </Link>
  );
}
