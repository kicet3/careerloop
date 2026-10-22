import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-bold text-slate-900">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white"
      >
        7
      </span>
      <span className="text-[15px] tracking-tight">이력서 심사위원단</span>
    </Link>
  );
}
