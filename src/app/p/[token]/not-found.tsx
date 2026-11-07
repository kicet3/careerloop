import Link from "next/link";
import { Logo } from "@/components/app/Logo";
import { buttonClass } from "@/components/ui/Button";

/** 없는 토큰·공개를 끈 링크·다시 만들어 바뀐 옛 링크가 모두 같은 화면이다(어느 경우인지 알리지 않는다). */
export default function PublicPortfolioNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <Logo />
      <h1 className="mt-8 text-xl font-bold text-slate-900">페이지를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-slate-500">주소가 잘못되었거나 더 이상 볼 수 없는 페이지입니다.</p>
      <Link href="/" className={buttonClass("primary", "md", "mt-6")}>
        처음으로
      </Link>
    </main>
  );
}
