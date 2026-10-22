import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-slate-50 px-4 py-12 sm:py-20">
      <div className="mx-auto w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2 text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            심
          </span>
          <span className="text-lg font-semibold tracking-tight">이력서 심사위원단</span>
        </Link>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">
          진단 결과는 언어 모델이 만든 두 번째 의견이며 면접·합격을 보장하지 않습니다.
        </p>
      </div>
    </div>
  );
}
