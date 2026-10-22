import Link from "next/link";
import { Logo } from "@/components/app/Logo";
import { buttonClass } from "@/components/ui/Button";

export default function SharedNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <Logo />
      <h1 className="mt-8 text-xl font-bold text-slate-900">볼 수 없는 공유 링크입니다</h1>
      <p className="mt-2 text-sm text-slate-500">링크가 잘못되었거나, 작성자가 공유를 해제했습니다.</p>
      <Link href="/" className={buttonClass("primary", "md", "mt-6")}>
        처음으로
      </Link>
    </main>
  );
}
