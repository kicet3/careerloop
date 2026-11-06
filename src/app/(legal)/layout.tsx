import { Logo } from "@/components/app/Logo";

/** 이용약관·개인정보 처리방침 등 법적 문서 틀(로그인 없이 볼 수 있다). */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-3xl items-center px-4 sm:px-6">
          <Logo />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">{children}</article>
      </main>
    </div>
  );
}
