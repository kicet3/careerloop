import Link from "next/link";
import { useId } from "react";
import { cn } from "@/components/ui/cn";
import { SERVICE_NAME } from "@/lib/brand";

/**
 * CareerLoop 심볼: 인디고→바이올렛 라운드 사각형 위에 열린 고리(C = Career)와,
 * 고리의 빈틈을 잇는 점(다음 단계로 이어지는 루프)을 얹었다. src/app/icon.svg와 같은 도형.
 */
export function LogoMark({ className }: { className?: string }) {
  const gid = `cl-grad-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-7 shrink-0", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gid}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
      <g transform="translate(-0.6 0)">
        <path
          d="M21.6 11.2A7.4 7.4 0 1 0 21.6 20.8"
          fill="none"
          stroke="#fff"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <circle cx="23.6" cy="16" r="2.1" fill="#c7d2fe" />
      </g>
    </svg>
  );
}

/** 워드마크: "Career"는 진하게, "Loop"는 브랜드 색. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "text-[16px] font-semibold tracking-[-0.02em] whitespace-nowrap",
        className,
      )}
    >
      <span className="text-slate-900">Career</span>
      <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
        Loop
      </span>
    </span>
  );
}

/**
 * compact: 좁은 화면(sm 미만)에서는 워드마크를 숨기고 심볼만 보인다.
 * iconOnly: 화면 폭과 상관없이 심볼만 보인다(접힌 사이드바).
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
      aria-label={hideText ? SERVICE_NAME : undefined}
      className={cn("flex items-center gap-2", hideText && "shrink-0")}
    >
      <LogoMark />
      {!iconOnly && <Wordmark className={cn(compact && "hidden sm:inline")} />}
    </Link>
  );
}
