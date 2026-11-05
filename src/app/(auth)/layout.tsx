import { BusinessInfo } from "@/components/app/BusinessInfo";
import { Logo } from "@/components/app/Logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-slate-50 px-4 py-12 sm:py-20">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
        <p className="mt-6 text-center text-xs leading-relaxed text-slate-500">
          진단 결과는 언어 모델이 만든 두 번째 의견이며 면접·합격을 보장하지 않습니다.
        </p>
        <BusinessInfo className="mt-4 text-center [&>p:first-child]:justify-center" />
      </div>
    </div>
  );
}
